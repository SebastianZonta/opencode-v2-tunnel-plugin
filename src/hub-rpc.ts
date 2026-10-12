import { Rpc } from "@opencode/plugin/rpc";

// Shared server<->CLI contract for arrival notices. Schema-only: no node
// imports, so the TUI process can load this without dragging in HubCore.
export const HubRpc = Rpc.define({
  id: "hub",
  methods: {},
  events: {
    message: {
      schema: {
        type: "object",
        properties: {
          from: { type: "string" },
          name: { type: "string" },
          text: { type: "string" },
        },
        required: ["from", "name", "text"],
        additionalProperties: false,
      },
    },
  },
});
