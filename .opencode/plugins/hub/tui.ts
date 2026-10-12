import { Plugin } from "@opencode/plugin/tui";
import { HubRpc } from "../../../src/hub-rpc";

// CLI-side companion to the hub server plugin: turns arrival RPC events
// into an injected session prompt (the agent reacts on its own) plus a
// TUI toast as backup. No manual hub_inbox polling needed.
export default Plugin.define({
  id: "hub.cli",
  setup(context) {
    const hub = context.client.rpc(HubRpc);
    const unsubscribe = hub.events.on("message", (event) => {
      const data = event.data as { name: string; text: string };
      context.ui.toast.show({
        title: `hub: message from ${data.name}`,
        message: data.text,
        variant: "info",
      });
      const route = context.ui.router.current();
      if (route.type !== "session") return;
      void context.client.session
        .prompt({
          sessionID: route.sessionID,
          text: `[hub] incoming message from ${data.name}: ${data.text} — find it in hub_inbox and answer with hub_reply <n> <text>.`,
        })
        .catch(() => {});
    });
    return () => {
      unsubscribe();
    };
  },
});
