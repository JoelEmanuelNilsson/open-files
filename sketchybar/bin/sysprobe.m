// sysprobe — everything the bar needs to know about this machine, from one
// resident process.
//
// WHY THIS EXISTS
//
// The conventional sketchybar config runs one shell script per item per tick.
// Ten items at one second each is ten fork+exec per second, forever, and each
// one shells out to `top`, `pmset`, `system_profiler` or `osascript` — none of
// which is cheap. The usual escape is SbarLua, which swaps the forks for a
// resident Lua interpreter.
//
// Neither is necessary. The forks were never the real cost: the cost is that
// every one of those tools is a process that boots a framework, asks one
// question and dies. So this asks all the questions, once, from inside a
// process that stays alive.
//
//   sysprobe stream     one line a second on stdout, forever, plus a line the
//                       instant the keyboard backlight or the audio device
//                       changes. The bar reads it and pushes one batched
//                       update. One fork per second, total, for the whole bar.
//
// It is also the only way to get two of these numbers at all. CPU load is a
// delta between two samples, so a one-shot process cannot compute it without
// leaving state on disk; staying resident makes it arithmetic. And the
// keyboard backlight has no shell interface whatsoever — see `kbd` below.
//
// BUILD
//   clang -fobjc-arc -O2 -framework Foundation -framework IOKit \
//         -framework CoreAudio -framework CoreFoundation sysprobe.m -o sysprobe
//
// COMMANDS
//   sysprobe stream        resident; `m` metrics lines at 1 Hz, `k`/`a` on change
//   sysprobe metrics       one metrics line and exit (cpu is 0 on the first call)
//   sysprobe kbd get       0.000000 - 1.000000
//   sysprobe kbd set <f>   absolute
//   sysprobe kbd step <f>  relative, clamped to [0,1]
//   sysprobe audio list    uid<TAB>name<TAB>type, one device per line
//   sysprobe audio cycle   move to the next output device, wrapping
//   sysprobe audio set <uid>

#import <Foundation/Foundation.h>
#import <AppKit/AppKit.h>
#import <CoreAudio/CoreAudio.h>
#import <SystemConfiguration/SystemConfiguration.h>
#import <IOKit/ps/IOPowerSources.h>
#import <IOKit/ps/IOPSKeys.h>
#import <mach/mach.h>
#import <sys/sysctl.h>
#import <dlfcn.h>
#import <objc/runtime.h>
#import <objc/message.h>

// ─── CPU ───────────────────────────────────────────────────────────────────
// host_processor_info gives cumulative tick counters per core, so a single
// reading means nothing: load is the ratio of busy ticks to total ticks
// *between two readings*. Hence the statics, and hence the first call always
// reporting 0.

static unsigned int  g_ncpu     = 0;
static processor_cpu_load_info_t g_prev = NULL;
static mach_msg_type_number_t    g_prevCount = 0;

static double cpu_busy_percent(void) {
  natural_t ncpu = 0;
  processor_cpu_load_info_t info = NULL;
  mach_msg_type_number_t count = 0;
  if (host_processor_info(mach_host_self(), PROCESSOR_CPU_LOAD_INFO,
                          &ncpu, (processor_info_array_t *)&info, &count) != KERN_SUCCESS)
    return -1.0;

  double pct = 0.0;
  if (g_prev) {
    uint64_t busy = 0, total = 0;
    for (natural_t i = 0; i < ncpu && i < g_ncpu; i++) {
      uint64_t u = info[i].cpu_ticks[CPU_STATE_USER]   - g_prev[i].cpu_ticks[CPU_STATE_USER];
      uint64_t s = info[i].cpu_ticks[CPU_STATE_SYSTEM] - g_prev[i].cpu_ticks[CPU_STATE_SYSTEM];
      uint64_t n = info[i].cpu_ticks[CPU_STATE_NICE]   - g_prev[i].cpu_ticks[CPU_STATE_NICE];
      uint64_t d = info[i].cpu_ticks[CPU_STATE_IDLE]   - g_prev[i].cpu_ticks[CPU_STATE_IDLE];
      busy += u + s + n;
      total += u + s + n + d;
    }
    if (total > 0) pct = 100.0 * (double)busy / (double)total;
    vm_deallocate(mach_task_self(), (vm_address_t)g_prev,
                  g_prevCount * sizeof(integer_t));
  }
  g_prev = info;
  g_prevCount = count;
  g_ncpu = ncpu;
  return pct;
}

// ─── Memory ────────────────────────────────────────────────────────────────
// "Used" is deliberately active + wired + compressed. Not inactive: macOS
// keeps inactive pages populated on purpose and counting them shows 90%+ on a
// machine that is doing nothing, which is the classic misleading memory
// readout. This matches what Activity Monitor calls memory pressure closely
// enough to be worth a colour change.

static double mem_used_percent(void) {
  vm_size_t page = 0;
  host_page_size(mach_host_self(), &page);
  vm_statistics64_data_t vm;
  mach_msg_type_number_t cnt = HOST_VM_INFO64_COUNT;
  if (host_statistics64(mach_host_self(), HOST_VM_INFO64,
                        (host_info64_t)&vm, &cnt) != KERN_SUCCESS)
    return -1.0;
  uint64_t used = ((uint64_t)vm.active_count + vm.wire_count +
                   vm.compressor_page_count) * page;
  int64_t total = 0; size_t len = sizeof(total);
  sysctlbyname("hw.memsize", &total, &len, NULL, 0);
  if (total <= 0) return -1.0;
  return 100.0 * (double)used / (double)total;
}

// ─── Battery ───────────────────────────────────────────────────────────────

// Low Power Mode.
//
// macOS calls it `powermode` in pmset and `LowPowerMode` in the preferences
// dictionary, and the two names describe the same tri-state: 0 automatic,
// 1 low, 2 high. There is a separate `HighPowerMode` key that is not it.
//
// IOPMCopyActivePMPreferences is not in a public header but it is an ordinary
// exported IOKit symbol, it needs no privilege to read, and it is what pmset
// itself calls. Reading it here rather than shelling out to `pmset -g custom`
// is the difference between zero forks and one a second, and one a second is
// more than the entire rest of this bar costs.
//
// Cached for five seconds. It is a stored preference, not a measurement -- it
// changes when you click the battery or when macOS drops into low power on its
// own at 20%, and neither of those needs to be noticed inside a second.
CFDictionaryRef IOPMCopyActivePMPreferences(void);

// File-scope rather than function-static so the SIGUSR1 handler in `stream`
// can drop the cache the instant a click changes the preference. Both live on
// the main queue, so no atomics are needed.
static int power_cached = 0;
static time_t power_cached_at = 0;

static int power_mode(int on_ac) {
  time_t now = time(NULL);
  if (power_cached_at && now - power_cached_at < 5) return power_cached;

  int mode = 0;
  CFDictionaryRef prefs = IOPMCopyActivePMPreferences();
  if (prefs) {
    NSDictionary *d = (__bridge_transfer NSDictionary *)prefs;
    NSDictionary *src = d[on_ac ? @"AC Power" : @"Battery Power"];
    NSNumber *v = src[@"LowPowerMode"];
    if (v) mode = v.intValue;
  }
  power_cached = mode; power_cached_at = now;
  return mode;
}

static void battery_read(int *pct, int *charging, int *present, int *on_ac) {
  *pct = -1; *charging = 0; *present = 0; *on_ac = 1;
  CFTypeRef blob = IOPSCopyPowerSourcesInfo();
  if (!blob) return;
  CFArrayRef list = IOPSCopyPowerSourcesList(blob);
  if (list) {
    for (CFIndex i = 0; i < CFArrayGetCount(list); i++) {
      CFDictionaryRef d = IOPSGetPowerSourceDescription(blob, CFArrayGetValueAtIndex(list, i));
      if (!d) continue;
      CFStringRef type = CFDictionaryGetValue(d, CFSTR(kIOPSTypeKey));
      if (!type || !CFEqual(type, CFSTR(kIOPSInternalBatteryType))) continue;
      *present = 1;
      CFNumberRef cur = CFDictionaryGetValue(d, CFSTR(kIOPSCurrentCapacityKey));
      CFNumberRef max = CFDictionaryGetValue(d, CFSTR(kIOPSMaxCapacityKey));
      int c = 0, m = 100;
      if (cur) CFNumberGetValue(cur, kCFNumberIntType, &c);
      if (max) CFNumberGetValue(max, kCFNumberIntType, &m);
      if (m > 0) *pct = (int)lround(100.0 * c / m);
      CFBooleanRef ch = CFDictionaryGetValue(d, CFSTR(kIOPSIsChargingKey));
      if (ch) *charging = CFBooleanGetValue(ch);
      // Plugged in and full is still AC, so this cannot be inferred from
      // `charging` -- the two answer different questions.
      CFStringRef st = CFDictionaryGetValue(d, CFSTR(kIOPSPowerSourceStateKey));
      *on_ac = st && CFEqual(st, CFSTR(kIOPSACPowerValue));
      break;
    }
    CFRelease(list);
  }
  CFRelease(blob);
}

// ─── Audio ─────────────────────────────────────────────────────────────────
//
// The trap that makes most volume readouts wrong: AirPods expose volume on
// channel elements 1 and 2 and have no main element at all, while the built-in
// speakers expose only a main element. Code that reads kAudioObjectPropertyElementMain
// and stops reports 0% forever on AirPods. So every read tries main, then
// falls back to channel 1.

static AudioObjectID audio_default_output(void) {
  AudioObjectID dev = kAudioObjectUnknown;
  UInt32 sz = sizeof(dev);
  AudioObjectPropertyAddress a = { kAudioHardwarePropertyDefaultOutputDevice,
                                   kAudioObjectPropertyScopeGlobal,
                                   kAudioObjectPropertyElementMain };
  AudioObjectGetPropertyData(kAudioObjectSystemObject, &a, 0, NULL, &sz, &dev);
  return dev;
}

static NSString *audio_string_prop(AudioObjectID dev, AudioObjectPropertySelector sel) {
  CFStringRef s = NULL; UInt32 sz = sizeof(s);
  AudioObjectPropertyAddress a = { sel, kAudioObjectPropertyScopeGlobal,
                                   kAudioObjectPropertyElementMain };
  if (AudioObjectGetPropertyData(dev, &a, 0, NULL, &sz, &s) != noErr || !s) return @"";
  NSString *r = (__bridge_transfer NSString *)s;
  return r ?: @"";
}

// Is this device an endpoint you put on your head?
//
// Transport type alone cannot answer that, and the two ways it fails are both
// real on this machine. USB-C EarPods report transport `usb `, exactly like a
// dock does. The 3.5mm jack reports `bltn`, exactly like the internal speakers
// do -- on Apple Silicon it is a separate device with its own codec driver,
// not a data source on the speaker device.
//
// So the terminal type is consulted as well, and it has to be read in two
// numbering schemes: Apple's Bluetooth stack reports the CoreAudio four-char
// code 'hdph', while Apple's built-in drivers report raw USB Audio Class
// terminal codes -- 0x0301 for a speaker, 0x0302 for headphones. Checking only
// one of the two is a bug that stays hidden until the day something is plugged
// into the jack.
static int audio_is_headphones(AudioObjectID dev) {
  AudioObjectPropertyAddress sa = { kAudioDevicePropertyStreams,
                                    kAudioDevicePropertyScopeOutput,
                                    kAudioObjectPropertyElementMain };
  UInt32 sz = 0;
  if (AudioObjectGetPropertyDataSize(dev, &sa, 0, NULL, &sz) == noErr && sz) {
    UInt32 n = sz / sizeof(AudioObjectID);
    AudioObjectID *streams = malloc(sz);
    if (AudioObjectGetPropertyData(dev, &sa, 0, NULL, &sz, streams) == noErr) {
      for (UInt32 i = 0; i < n; i++) {
        UInt32 term = 0, tsz = sizeof(term);
        AudioObjectPropertyAddress ta = { kAudioStreamPropertyTerminalType,
                                          kAudioObjectPropertyScopeGlobal,
                                          kAudioObjectPropertyElementMain };
        if (AudioObjectGetPropertyData(streams[i], &ta, 0, NULL, &tsz, &term) == noErr &&
            (term == kAudioStreamTerminalTypeHeadphones || term == 0x0302)) {
          free(streams);
          return 1;
        }
      }
    }
    free(streams);
  }
  // Third signal, for the older arrangement where the jack is a data source on
  // the speaker device rather than a device of its own.
  UInt32 src = 0; sz = sizeof(src);
  AudioObjectPropertyAddress da = { kAudioDevicePropertyDataSource,
                                    kAudioDevicePropertyScopeOutput,
                                    kAudioObjectPropertyElementMain };
  if (AudioObjectGetPropertyData(dev, &da, 0, NULL, &sz, &src) == noErr &&
      src == 'hdpn')
    return 1;
  return 0;
}

// Classify by what CoreAudio reports, never by the device's name. Names are a
// trap here: this machine calls its AirPods "Joel's AirPods Pro" with a curly
// U+2019 apostrophe, and the same name is used by both the input and the output
// device, so it is neither ASCII nor unique. The UID is both.
static const char *audio_kind(AudioObjectID dev) {
  UInt32 t = 0, sz = sizeof(t);
  AudioObjectPropertyAddress a = { kAudioDevicePropertyTransportType,
                                   kAudioObjectPropertyScopeGlobal,
                                   kAudioObjectPropertyElementMain };
  if (AudioObjectGetPropertyData(dev, &a, 0, NULL, &sz, &t) != noErr) return "other";
  int hp = audio_is_headphones(dev);
  switch (t) {
    case kAudioDeviceTransportTypeBuiltIn:      return hp ? "wired" : "builtin";
    case kAudioDeviceTransportTypeUSB:          return hp ? "wired" : "usb";
    case kAudioDeviceTransportTypeBluetooth:
    case kAudioDeviceTransportTypeBluetoothLE:  return "bluetooth";
    case kAudioDeviceTransportTypeHDMI:
    case kAudioDeviceTransportTypeDisplayPort:  return "display";
    case kAudioDeviceTransportTypeAirPlay:      return "airplay";
    case kAudioDeviceTransportTypeVirtual:
    case kAudioDeviceTransportTypeAggregate:    return "virtual";
    default:                                    return "other";
  }
}

static int audio_has_output(AudioObjectID dev) {
  AudioObjectPropertyAddress a = { kAudioDevicePropertyStreamConfiguration,
                                   kAudioDevicePropertyScopeOutput,
                                   kAudioObjectPropertyElementMain };
  UInt32 sz = 0;
  if (AudioObjectGetPropertyDataSize(dev, &a, 0, NULL, &sz) != noErr || sz == 0) return 0;
  AudioBufferList *bl = malloc(sz);
  int n = 0;
  if (AudioObjectGetPropertyData(dev, &a, 0, NULL, &sz, bl) == noErr)
    for (UInt32 i = 0; i < bl->mNumberBuffers; i++) n += bl->mBuffers[i].mNumberChannels;
  free(bl);
  return n > 0;
}

static double audio_volume(AudioObjectID dev) {
  Float32 v = 0; UInt32 sz = sizeof(v);
  AudioObjectPropertyAddress a = { kAudioDevicePropertyVolumeScalar,
                                   kAudioDevicePropertyScopeOutput,
                                   kAudioObjectPropertyElementMain };
  if (AudioObjectHasProperty(dev, &a) &&
      AudioObjectGetPropertyData(dev, &a, 0, NULL, &sz, &v) == noErr)
    return v * 100.0;
  a.mElement = 1;                       // the AirPods case
  if (AudioObjectHasProperty(dev, &a) &&
      AudioObjectGetPropertyData(dev, &a, 0, NULL, &sz, &v) == noErr)
    return v * 100.0;
  return -1.0;
}

static int audio_muted(AudioObjectID dev) {
  UInt32 m = 0, sz = sizeof(m);
  AudioObjectPropertyAddress a = { kAudioDevicePropertyMute,
                                   kAudioDevicePropertyScopeOutput,
                                   kAudioObjectPropertyElementMain };
  if (AudioObjectHasProperty(dev, &a) &&
      AudioObjectGetPropertyData(dev, &a, 0, NULL, &sz, &m) == noErr) return m ? 1 : 0;
  a.mElement = 1;
  if (AudioObjectHasProperty(dev, &a) &&
      AudioObjectGetPropertyData(dev, &a, 0, NULL, &sz, &m) == noErr) return m ? 1 : 0;
  return 0;
}

static NSArray<NSNumber *> *audio_outputs(void) {
  AudioObjectPropertyAddress a = { kAudioHardwarePropertyDevices,
                                   kAudioObjectPropertyScopeGlobal,
                                   kAudioObjectPropertyElementMain };
  UInt32 sz = 0;
  if (AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, &a, 0, NULL, &sz) != noErr)
    return @[];
  UInt32 n = sz / sizeof(AudioObjectID);
  AudioObjectID *ids = malloc(sz);
  NSMutableArray *out = [NSMutableArray array];
  if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &a, 0, NULL, &sz, ids) == noErr)
    for (UInt32 i = 0; i < n; i++)
      if (audio_has_output(ids[i])) [out addObject:@(ids[i])];
  free(ids);
  return out;
}

// The cycle order: wired, then wireless, then the speakers, then wrap.
//
// CoreAudio's own device order -- which is what `SwitchAudioSource -n` steps
// through -- is the order devices happened to arrive, not a sorted order. It
// is neither by id nor by name nor grouped by direction, so a cycle built on
// it runs in a different sequence depending on what you plugged in first, and
// there is no way to say what the next device will be before you click.
//
// Sorting here gives an order that depends only on which devices exist. The
// built-in speakers are deliberately ranked last, because they are the one
// device that is always present: making them the anchor means the wrap-around
// always lands back on the headphones, and the shape of the cycle never
// changes as things come and go.
static int kind_rank(const char *k) {
  if (!strcmp(k, "wired"))     return 0;
  if (!strcmp(k, "bluetooth")) return 1;
  if (!strcmp(k, "usb"))       return 2;
  if (!strcmp(k, "display"))   return 3;
  if (!strcmp(k, "airplay"))   return 4;
  if (!strcmp(k, "builtin"))   return 8;   // always the home position
  return 6;
}

static NSArray<NSNumber *> *audio_outputs_ordered(void) {
  NSMutableArray *real = [NSMutableArray array];
  for (NSNumber *d in audio_outputs())
    // Aggregate and virtual devices are kept out of the rotation entirely, so
    // installing something like BlackHole or Loopback never silently adds a
    // step to the cycle that sends your audio nowhere.
    if (strcmp(audio_kind(d.unsignedIntValue), "virtual"))
      [real addObject:d];

  return [real sortedArrayUsingComparator:^NSComparisonResult(NSNumber *x, NSNumber *y) {
    int rx = kind_rank(audio_kind(x.unsignedIntValue));
    int ry = kind_rank(audio_kind(y.unsignedIntValue));
    if (rx != ry) return rx < ry ? NSOrderedAscending : NSOrderedDescending;
    // Tie-break on UID, not name: UIDs are ASCII, stable and unique, and names
    // are none of the three.
    NSString *ux = audio_string_prop(x.unsignedIntValue, kAudioDevicePropertyDeviceUID);
    NSString *uy = audio_string_prop(y.unsignedIntValue, kAudioDevicePropertyDeviceUID);
    return [ux compare:uy];
  }];
}

static int audio_set_default(AudioObjectID dev) {
  AudioObjectPropertyAddress a = { kAudioHardwarePropertyDefaultOutputDevice,
                                   kAudioObjectPropertyScopeGlobal,
                                   kAudioObjectPropertyElementMain };
  return AudioObjectSetPropertyData(kAudioObjectSystemObject, &a, 0, NULL,
                                    sizeof(dev), &dev) == noErr;
}

// ─── Network ───────────────────────────────────────────────────────────────
//
// Deliberately not the SSID. On macOS 26 every route to the network name —
// `networksetup -getairportnetwork`, `ipconfig getsummary`, CoreWLAN — returns
// `<redacted>` unless the asking process holds Location Services authorisation,
// because the list of networks in range is a location fingerprint. Measured on
// this machine: `ipconfig getsummary en0` returns literally `<redacted>`. A
// status bar daemon prompting for your location in order to draw a wifi glyph
// is a bad trade, so this answers the question you actually have — am I on,
// and over what — and leaves the name out of it.
//
// The primary interface comes from the dynamic store rather than a hardcoded
// `en0`, so the answer stays right when traffic moves to ethernet or a tether.

static void net_read(char *iface, size_t n, int *up) {
  iface[0] = '\0';
  *up = 0;
  SCDynamicStoreRef s = SCDynamicStoreCreate(NULL, CFSTR("sysprobe"), NULL, NULL);
  if (!s) return;
  CFDictionaryRef g = SCDynamicStoreCopyValue(s, CFSTR("State:/Network/Global/IPv4"));
  if (g) {
    CFStringRef pi = CFDictionaryGetValue(g, kSCDynamicStorePropNetPrimaryInterface);
    if (pi) {
      CFStringGetCString(pi, iface, n, kCFStringEncodingUTF8);
      *up = 1;
    }
    CFRelease(g);
  }
  CFRelease(s);
}

// Is the primary interface the Wi-Fi one? Asked by interface type rather than
// by name, so this survives a machine where Wi-Fi is not en0.
static int net_is_wifi(const char *iface) {
  if (!iface || !iface[0]) return 0;
  int wifi = 0;
  CFArrayRef ifs = SCNetworkInterfaceCopyAll();
  if (ifs) {
    for (CFIndex i = 0; i < CFArrayGetCount(ifs); i++) {
      SCNetworkInterfaceRef ni = (SCNetworkInterfaceRef)CFArrayGetValueAtIndex(ifs, i);
      CFStringRef bsd = SCNetworkInterfaceGetBSDName(ni);
      if (!bsd) continue;
      char nm[32] = {0};
      CFStringGetCString(bsd, nm, sizeof(nm), kCFStringEncodingUTF8);
      if (strcmp(nm, iface)) continue;
      CFStringRef type = SCNetworkInterfaceGetInterfaceType(ni);
      wifi = (type && CFEqual(type, kSCNetworkInterfaceTypeIEEE80211));
      break;
    }
    CFRelease(ifs);
  }
  return wifi;
}

// ─── Keyboard backlight ────────────────────────────────────────────────────
//
// There is no shell route to this. ioreg, nvram, defaults and every Homebrew
// brightness tool come back empty — the level lives behind a private
// Objective-C class in CoreBrightness and is reached over XPC to
// corebrightnessd. So it is dlopen'd and messaged by hand.
//
// The type signatures are load-bearing. brightnessForKeyboard: returns a float
// and takes a uint64_t; casting objc_msgSend wrongly on arm64 does not fail,
// it reads the wrong register and returns plausible nonsense.

static id  g_kbd = nil;
static uint64_t g_kbdID = 0;

static int kbd_init(void) {
  if (g_kbd) return 1;
  if (!dlopen("/System/Library/PrivateFrameworks/CoreBrightness.framework/CoreBrightness", RTLD_NOW))
    return 0;
  Class C = objc_getClass("KeyboardBrightnessClient");
  if (!C) return 0;
  id alloc = ((id(*)(id, SEL))objc_msgSend)((id)C, sel_registerName("alloc"));
  g_kbd = ((id(*)(id, SEL))objc_msgSend)(alloc, sel_registerName("init"));
  if (!g_kbd) return 0;
  NSArray *ids = ((id(*)(id, SEL))objc_msgSend)(g_kbd, sel_registerName("copyKeyboardBacklightIDs"));
  if (!ids.count) { g_kbd = nil; return 0; }
  g_kbdID = [ids[0] unsignedLongLongValue];
  return 1;
}

static double kbd_get(void) {
  if (!kbd_init()) return -1.0;
  return ((float(*)(id, SEL, uint64_t))objc_msgSend)(
           g_kbd, sel_registerName("brightnessForKeyboard:"), g_kbdID);
}

static int kbd_set(double v) {
  if (!kbd_init()) return 0;
  if (v < 0) v = 0; if (v > 1) v = 1;
  return ((BOOL(*)(id, SEL, float, uint64_t))objc_msgSend)(
           g_kbd, sel_registerName("setBrightness:forKeyboard:"), (float)v, g_kbdID);
}

// ─── Output ────────────────────────────────────────────────────────────────

static void emit_metrics(void) {
  double cpu = cpu_busy_percent();
  double mem = mem_used_percent();
  int bp, bc, bpr, bac; battery_read(&bp, &bc, &bpr, &bac);
  AudioObjectID dev = audio_default_output();
  NSString *name = audio_string_prop(dev, kAudioObjectPropertyName);
  char iface[32]; int netup = 0;
  net_read(iface, sizeof(iface), &netup);

  // The clock is emitted from here rather than read by the shell because
  // macOS ships bash 3.2, which has neither `printf %()T` nor EPOCHSECONDS.
  // Formatting it there would mean a `date` fork every single second, which
  // would be the only fork left in the whole design.
  //
  // "22_Sep_Tue_19:25". Underscores, not spaces: this line is space-separated
  // key=value pairs, and bin/pump turns them back into spaces. No setlocale,
  // so %b and %a are the C locale's English names.
  char hhmm[32];
  time_t now = time(NULL);
  struct tm lt;
  localtime_r(&now, &lt);
  strftime(hhmm, sizeof(hhmm), "%d_%b_%a_%H:%M", &lt);

  // `ac` and `charging` answer different questions and diverge exactly when
  // it matters: held at the charge limit, macOS reports IsCharging false
  // while the cable is in. The boost button keys off the cable.
  printf("m cpu=%.1f mem=%.1f batt=%d charging=%d ac=%d batt_present=%d power=%d "
         "kbd=%.3f vol=%.0f mute=%d net_up=%d net_wifi=%d net_if=%s clock=%s "
         "audio_kind=%s audio_name=%s\n",
         cpu < 0 ? 0.0 : cpu, mem < 0 ? 0.0 : mem, bp, bc, bac, bpr,
         power_mode(bac),
         kbd_get(), audio_volume(dev), audio_muted(dev),
         netup, net_is_wifi(iface), iface[0] ? iface : "-", hhmm,
         audio_kind(dev), name.UTF8String ?: "");
  fflush(stdout);
}

static void emit_audio(void) {
  AudioObjectID dev = audio_default_output();
  NSString *name = audio_string_prop(dev, kAudioObjectPropertyName);
  printf("a vol=%.0f mute=%d audio_kind=%s audio_name=%s\n",
         audio_volume(dev), audio_muted(dev), audio_kind(dev), name.UTF8String ?: "");
  fflush(stdout);
}

static void emit_kbd(void) {
  printf("k kbd=%.3f\n", kbd_get());
  fflush(stdout);
}

// ─── Listeners ─────────────────────────────────────────────────────────────
// Volume, mute and device changes are pushed by CoreAudio, so the 1 Hz timer
// is only ever responsible for cpu, memory and battery. Moving the volume
// slider updates the bar immediately, not up to a second later.

static AudioObjectID g_watched = kAudioObjectUnknown;

static OSStatus on_device_prop(AudioObjectID o, UInt32 n,
                               const AudioObjectPropertyAddress *a, void *c) {
  (void)o; (void)n; (void)a; (void)c;
  emit_audio();
  return noErr;
}

static void watch_device(AudioObjectID dev) {
  AudioObjectPropertyAddress addrs[] = {
    { kAudioDevicePropertyVolumeScalar, kAudioDevicePropertyScopeOutput, kAudioObjectPropertyElementMain },
    { kAudioDevicePropertyVolumeScalar, kAudioDevicePropertyScopeOutput, 1 },
    { kAudioDevicePropertyMute,         kAudioDevicePropertyScopeOutput, kAudioObjectPropertyElementMain },
    { kAudioDevicePropertyMute,         kAudioDevicePropertyScopeOutput, 1 },
  };
  for (size_t i = 0; i < sizeof(addrs) / sizeof(addrs[0]); i++) {
    if (g_watched != kAudioObjectUnknown)
      AudioObjectRemovePropertyListener(g_watched, &addrs[i], on_device_prop, NULL);
    if (dev != kAudioObjectUnknown)
      AudioObjectAddPropertyListener(dev, &addrs[i], on_device_prop, NULL);
  }
  g_watched = dev;
}

static OSStatus on_default_changed(AudioObjectID o, UInt32 n,
                                   const AudioObjectPropertyAddress *a, void *c) {
  (void)o; (void)n; (void)a; (void)c;
  watch_device(audio_default_output());
  emit_audio();
  return noErr;
}

static void kbd_watch(void) {
  if (!kbd_init()) return;
  // The block must be heap-copied: a stack block dies with this frame and the
  // callback then jumps into freed memory. It must also be declared with zero
  // parameters — declaring more than the caller passes makes it read garbage
  // registers as objects and crash.
  void (^blk)(void) = [^{ emit_kbd(); } copy];
  ((void(*)(id, SEL, id, uint64_t, id))objc_msgSend)(
    g_kbd, sel_registerName("registerNotificationForKeys:keyboardID:block:"),
    @[@"KeyboardBacklightBrightness"], g_kbdID, blk);
}

// ─── The screen ────────────────────────────────────────────────────────────
//
// The bar's height is not a taste decision and must not be a guess.
//
// macOS reserves a strip at the top of a notched display and hands apps the
// rest: `visibleFrame` is 32pt shorter than `frame` here, and that 32 is
// exactly `safeAreaInsets.top`, which is exactly the depth of the notch. Make
// the bar that tall and its bottom edge lands on the notch's bottom edge. Make
// it taller -- 38 was the first guess, from the 37pt the menu bar looks like --
// and a strip of bar hangs below the notch with a visible seam across the whole
// screen.
//
// The same applies sideways. The notch is 185pt wide on this machine, measured
// as the gap between the two auxiliary areas macOS reports either side of it.
// sketchybar's default reservation is 200, which throws away 15 points.
//
// Reporting it rather than hardcoding it means the numbers are also right on an
// external display, where there is no notch and the insets are zero.
static void emit_screen(void) {
  NSScreen *s = NSScreen.mainScreen;
  CGFloat safeTop = 0, notchW = 0;
  if (s) {
    safeTop = s.safeAreaInsets.top;
    if (@available(macOS 12.0, *)) {
      NSRect l = s.auxiliaryTopLeftArea.size.width  ? s.auxiliaryTopLeftArea  : NSZeroRect;
      NSRect r = s.auxiliaryTopRightArea.size.width ? s.auxiliaryTopRightArea : NSZeroRect;
      if (l.size.width > 0 && r.size.width > 0)
        notchW = r.origin.x - (l.origin.x + l.size.width);
    }
  }
  // No notch: fall back to the height of the menu bar this display would have
  // drawn, so an external monitor gets a bar the size of the thing it replaces.
  if (safeTop <= 0) safeTop = NSStatusBar.systemStatusBar.thickness;
  printf("width=%.0f height=%.0f bar=%.0f notch=%.0f\n",
         s ? s.frame.size.width : 1728, s ? s.frame.size.height : 1117,
         safeTop, notchW);
}

int main(int argc, char **argv) { @autoreleasepool {
  const char *cmd = argc > 1 ? argv[1] : "stream";

  if (!strcmp(cmd, "metrics")) { emit_metrics(); return 0; }
  if (!strcmp(cmd, "screen"))  { emit_screen();  return 0; }

  if (!strcmp(cmd, "kbd")) {
    const char *sub = argc > 2 ? argv[2] : "get";
    if (!strcmp(sub, "get"))  { printf("%.3f\n", kbd_get()); return 0; }
    if (!strcmp(sub, "set") && argc > 3) return kbd_set(atof(argv[3])) ? 0 : 1;
    if (!strcmp(sub, "step") && argc > 3) {
      double cur = kbd_get();
      if (cur < 0) return 1;
      return kbd_set(cur + atof(argv[3])) ? 0 : 1;
    }
    return 64;
  }

  if (!strcmp(cmd, "audio")) {
    const char *sub = argc > 2 ? argv[2] : "list";
    NSArray<NSNumber *> *devs = audio_outputs_ordered();
    if (!strcmp(sub, "list")) {
      AudioObjectID cur = audio_default_output();
      for (NSNumber *d in devs) {
        AudioObjectID id_ = d.unsignedIntValue;
        printf("%s\t%s\t%s\t%s\n",
               id_ == cur ? "*" : "-",
               audio_string_prop(id_, kAudioDevicePropertyDeviceUID).UTF8String ?: "",
               audio_kind(id_),
               audio_string_prop(id_, kAudioObjectPropertyName).UTF8String ?: "");
      }
      return 0;
    }
    if (!strcmp(sub, "cycle")) {
      if (devs.count < 2) return 0;
      AudioObjectID cur = audio_default_output();
      NSUInteger at = [devs indexOfObject:@(cur)];
      NSUInteger next = (at == NSNotFound) ? 0 : (at + 1) % devs.count;
      return audio_set_default(devs[next].unsignedIntValue) ? 0 : 1;
    }
    if (!strcmp(sub, "set") && argc > 3) {
      NSString *want = @(argv[3]);
      for (NSNumber *d in devs)
        if ([audio_string_prop(d.unsignedIntValue, kAudioDevicePropertyDeviceUID) isEqual:want])
          return audio_set_default(d.unsignedIntValue) ? 0 : 1;
      return 1;
    }
    return 64;
  }

  if (!strcmp(cmd, "stream")) {
    double interval = argc > 2 ? atof(argv[2]) : 1.0;

    AudioObjectPropertyAddress def = { kAudioHardwarePropertyDefaultOutputDevice,
                                       kAudioObjectPropertyScopeGlobal,
                                       kAudioObjectPropertyElementMain };
    AudioObjectAddPropertyListener(kAudioObjectSystemObject, &def, on_default_changed, NULL);
    watch_device(audio_default_output());
    kbd_watch();

    cpu_busy_percent();                       // prime the delta
    dispatch_source_t t = dispatch_source_create(
      DISPATCH_SOURCE_TYPE_TIMER, 0, 0, dispatch_get_main_queue());
    dispatch_source_set_timer(t, dispatch_time(DISPATCH_TIME_NOW, (int64_t)(interval * NSEC_PER_SEC)),
                              (uint64_t)(interval * NSEC_PER_SEC), NSEC_PER_SEC / 10);
    dispatch_source_set_event_handler(t, ^{ emit_metrics(); });
    dispatch_resume(t);

    // A click just flipped Low Power Mode. The 5-second cache above is right
    // for a stored preference and wrong for the one second after a click, so
    // plugins/power-toggle sends SIGUSR1: drop the cache and emit a fresh
    // line now, and the next pump frame paints the truth instead of the past.
    signal(SIGUSR1, SIG_IGN);
    dispatch_source_t sig = dispatch_source_create(
      DISPATCH_SOURCE_TYPE_SIGNAL, SIGUSR1, 0, dispatch_get_main_queue());
    dispatch_source_set_event_handler(sig, ^{ power_cached_at = 0; emit_metrics(); });
    dispatch_resume(sig);

    // If the bar goes away, so does this. Without it a reload leaves an
    // orphan probe behind and they accumulate one per reload.
    signal(SIGPIPE, SIG_DFL);
    dispatch_main();
  }

  fprintf(stderr, "usage: sysprobe stream|metrics|kbd|audio\n");
  return 64;
}}
