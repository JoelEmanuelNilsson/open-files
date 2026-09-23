// Make the macOS menu bar render at alpha 0, for as long as this runs.
//
// ── The problem ────────────────────────────────────────────────────────────
//
// Auto-hide is not hiding. It reclaims the layout space, which is why windows
// start at the top of the screen, but the bar is still there and still slides
// back down the moment the pointer touches the top edge -- underneath our own
// bar, which is transparent now, so it shows straight through.
//
// ── Why the obvious attempts fail ──────────────────────────────────────────
//
// `defaults write _HIHideMenuBar` and System Events' `autohide menu bar` both
// set the same preference, and that preference is the auto-hide behaviour --
// the thing that is already on and already insufficient.
//
// NSApplicationPresentationHideMenuBar is dead here. Presentation options only
// apply to the *active* application, and a window-less accessory process can
// never become active: `activate(ignoringOtherApps:)` returns, `isActive`
// stays false, the option is accepted and nothing happens.
//
// SLSSetMenuBarVisibilityOverrideOnDisplay(cid, display, true) is quoted all
// over the internet as the way to hide it. It does the exact opposite: it is a
// show-override, and it forces the bar visible. Measured with values 0, 1, 2,
// 3 and 255 -- there is no value of it that hides anything.
//
// ── What actually works ────────────────────────────────────────────────────
//
// SkyLight has a per-connection "menu bar system override alpha". Set it to 0
// and the WindowServer composites the menu bar at zero opacity: it still
// exists, still reveals on hover, and never puts a pixel on the screen.
//
// The override is keyed to the connection that sent it. That single fact is
// why one-shot tools appear not to work at all -- they set it, exit, their
// connection dies, and the WindowServer drops the override with it. So this
// process has to stay alive. That is a feature rather than a cost: nothing is
// written to disk, no preference is changed, and killing this restores the
// menu bar completely and instantly.
//
// ── Tied to the bar's life on purpose ──────────────────────────────────────
//
// bin/supervise owns this, which means the menu bar comes back whenever the
// status bar is not running. A LaunchAgent would hold it hidden through a
// sketchybar crash, and that is the wrong trade: it would leave a machine with
// no menu bar and no replacement for it, which is not a tidy screen, it is a
// screen you cannot use. The menu bar is hidden because something better is
// covering that strip. When nothing is, you should have it back.
//
// build:
//   clang -O2 -o hide-menubar hide-menubar.c \
//     -framework ApplicationServices -framework CoreGraphics \
//     -F /System/Library/PrivateFrameworks -framework SkyLight

#include <ApplicationServices/ApplicationServices.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

// Read out of the disassembly on macOS 26.6.2 (25G83), arm64. The alpha is a
// 32-bit float and not a double -- the callee does `str s0`. Declaring it
// double happens to work for 0.0 only because both are all-zero bits, and
// would quietly break for any other value.
typedef int CGSConnectionID;
extern CGSConnectionID SLSMainConnectionID(void);
extern CGError SLSSetMenuBarSystemOverrideAlpha(CGSConnectionID cid,
                                                void *token, float alpha);

static float g_alpha = 0.0f;

static void apply(void) {
  CGSConnectionID cid = SLSMainConnectionID();
  if (cid) SLSSetMenuBarSystemOverrideAlpha(cid, NULL, g_alpha);
}

// Plugging in a display rebuilds the menu bar, and the new one has not heard
// about the override.
static void on_reconfig(CGDirectDisplayID d, CGDisplayChangeSummaryFlags f,
                        void *u) {
  (void)d; (void)f; (void)u;
  apply();
}

// Insurance against the states nobody can test from a script -- display sleep,
// fast user switching, a WindowServer restart. One mach message every three
// seconds is far below the noise floor of everything else on this bar.
static void on_timer(CFRunLoopTimerRef t, void *u) { (void)t; (void)u; apply(); }

int main(int argc, char **argv) {
  if (argc > 1) g_alpha = (float)atof(argv[1]);   // 0.0 hides, 1.0 restores
  signal(SIGPIPE, SIG_IGN);

  apply();
  CGDisplayRegisterReconfigurationCallback(on_reconfig, NULL);

  CFRunLoopTimerRef t = CFRunLoopTimerCreate(
      NULL, CFAbsoluteTimeGetCurrent() + 3.0, 3.0, 0, 0, on_timer, NULL);
  CFRunLoopAddTimer(CFRunLoopGetMain(), t, kCFRunLoopCommonModes);

  CFRunLoopRun();
  return 0;
}
