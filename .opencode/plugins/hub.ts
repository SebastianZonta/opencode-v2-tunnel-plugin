import { type Plugin, tool } from "@opencode-ai/plugin";
import { BASE_PORT, createId, HubCore } from "../../src/hub";

// One hub per opencode process. Replies arrive in ticket 04;
// this file stays a thin adapter over HubCore (tested in src/).
const hub = new HubCore(createId(), "hub");

export const HubPlugin: Plugin = async () => {
  return {
    tool: {
      hub_start: tool({
        description:
          "Start the LAN hub: open the HTTP listener for incoming P2P messages.",
        args: {
          port: tool.schema.number().optional(),
        },
        async execute(args) {
          const port = await hub.start(args.port ?? BASE_PORT);
          return `hub listening on ${port} as ${hub.name} (${hub.id})`;
        },
      }),

      hub_stop: tool({
        description: "Stop the LAN hub HTTP listener.",
        args: {},
        async execute() {
          await hub.stop();
          return "hub stopped";
        },
      }),

      hub_send: tool({
        description:
          "Send a text message to a hub listener URL (ticket 01: loopback only).",
        args: {
          url: tool.schema.string(),
          to: tool.schema.string(),
          text: tool.schema.string(),
        },
        async execute(args) {
          const result = await hub.send(args.url, {
            id: createId(),
            from: hub.id,
            to: args.to,
            type: "request",
            text: args.text,
            ts: new Date().toISOString(),
          });
          return result.status;
        },
      }),

      hub_inbox: tool({
        description: "List messages this hub has received.",
        args: {},
        async execute() {
          const items = hub.inbox();
          if (items.length === 0) return "(inbox empty)";
          return items
            .map((m, i) => `${i + 1}. [${m.type}] ${m.from}: ${m.text}`)
            .join("\n");
        },
      }),

      hub_peers: tool({
        description: "List discovered LAN peers: name, paired?, last seen.",
        args: {},
        async execute() {
          const peers = hub.peers();
          if (peers.length === 0) return "(no peers discovered yet)";
          return peers
            .map(
              (p, i) =>
                `${i + 1}. ${p.name} (${p.id.slice(0, 8)}) ` +
                `paired:${p.paired ? "yes" : "no"} ` +
                `last-seen:${Math.round((Date.now() - p.lastSeen) / 1000)}s ago`,
            )
            .join("\n");
        },
      }),

      hub_pair: tool({
        description:
          "Pairing: no code issues a 6-digit single-use 5-minute code for a peer; with code redeems it and trusts the peer.",
        args: {
          peer: tool.schema.string(),
          name: tool.schema.string().optional(),
          code: tool.schema.string().optional(),
        },
        async execute(args) {
          if (args.code === undefined) {
            const code = hub.issuePairingCode();
            return `pairing code for ${args.peer}: ${code} (single-use, 5 min)`;
          }
          const peer = hub.redeemPairingCode(
            args.code,
            args.peer,
            args.name ?? args.peer,
          );
          return `paired with ${peer.name} (${peer.id})`;
        },
      }),

      hub_unpair: tool({
        description: "Forget a paired peer; their messages will be rejected.",
        args: {
          peer: tool.schema.string(),
        },
        async execute(args) {
          return hub.unpair(args.peer)
            ? `unpaired ${args.peer}`
            : `${args.peer} was not paired`;
        },
      }),
    },
  };
};
