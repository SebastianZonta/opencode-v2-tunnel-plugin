import { Plugin } from "@opencode/plugin/tui";
import { HubRpc } from "../../src/hub-rpc";

// CLI-side companion to the hub server plugin: turns arrival RPC events
// into TUI toasts. Poll hub_inbox for the messages themselves.
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
    });
    return () => {
      unsubscribe();
    };
  },
});
