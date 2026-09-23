// Wake PowerUIAgent, so it reads its settings *now* rather than eventually.
//
// The boost button (plugins/charge-boost) changes the native charge limit by
// rewriting PowerUIAgent's plist and SIGKILLing it -- the agent caches its
// settings for life and ignores SIGTERM, and SIP blocks `launchctl
// kickstart`. But launchd only respawns it *on demand*, and a machine that
// is just sitting there can leave it dead for minutes: the new limit sits
// unread in the plist the whole time, and the click looks like it did
// nothing.
//
// This is the demand. Knocking on the agent's XPC service is enough to make
// launchd spawn it; the agent then rejects us -- answering the service
// properly needs the com.apple.powerui.smartcharging entitlement, which only
// Apple can sign -- but by then it is up, has read the plist, and has
// re-registered the limit with powerd. Rejection is the expected success
// path here. Measured: `pmset -g battlimit` follows within seconds of this
// knock, against minutes without it.
//
// MACH_SERVICE_PRIVILEGED because the service lives in launchd's system
// domain. The sync wait is bounded: launchd always answers -- with the
// agent's rejection or with an error -- so this cannot hang the caller.
//
// Compiled by install.sh, like hide-menubar.c. Plain libSystem, no
// frameworks.
#include <xpc/xpc.h>

int main(void) {
  xpc_connection_t c = xpc_connection_create_mach_service(
      "com.apple.powerui.smartChargeManager", NULL,
      XPC_CONNECTION_MACH_SERVICE_PRIVILEGED);
  xpc_connection_set_event_handler(c, ^(xpc_object_t e) { (void)e; });
  xpc_connection_resume(c);
  xpc_object_t m = xpc_dictionary_create(NULL, NULL, 0);
  xpc_dictionary_set_string(m, "wake", "knock");
  xpc_object_t r = xpc_connection_send_message_with_reply_sync(c, m);
  (void)r;
  return 0;
}
