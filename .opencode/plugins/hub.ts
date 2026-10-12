import { type Plugin, tool } from "@opencode-ai/plugin";
import {
  BASE_PORT,
  createId,
  HubCore,
  isNotice,
  type Envelope,
} from "../../src/hub";

// One hub per opencode process. Replies arrive in ticket 04;
// this file stays a thin adapter over HubCore (tested in src/).
const hub = new HubCore(createId(), "hub");

const displayName = (id: string): string =>
  id === hub.id
    ? `${hub.name} (you)`
    : (hub.peers().find((p) => p.id === id)?.name ?? id.slice(0, 8));

export const HubPlugin: Plugin = async (input) => {
  // Arrival UX (spec section 5): toast on every queued incoming message.
  // Fire-and-forget: a failed toast must never break receipt.
  hub.onMessage = (m) => {
    const name =
      hub.peers().find((p) => p.id === m.from)?.name ?? "unknown peer";
    void Promise.resolve(
      input.client.tui.showToast({
        body: {
          title: `hub: message from ${name}`,
          message: m.text.slice(0, 200),
          variant: "info",
        },
      }),
    ).catch(() => {});
  };
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
          "Send a text message to a peer by number or name (see hub_peers); ambiguous names are refused.",
        args: {
          peer: tool.schema.string(),
          text: tool.schema.string(),
        },
        async execute(args) {
          try {
            const result = await hub.sendToPeer(args.peer, args.text);
            return result.status;
          } catch (e) {
            return e instanceof Error ? e.message : String(e);
          }
        },
      }),

      hub_reply: tool({
        description:
          "Answer inbox item n (see hub_inbox); the reply fills inReplyTo invisibly.",
        args: {
          n: tool.schema.number(),
          text: tool.schema.string(),
        },
        async execute(args) {
          try {
            const result = await hub.reply(args.n, args.text);
            return result.status;
          } catch (e) {
            return e instanceof Error ? e.message : String(e);
          }
        },
      }),

      hub_inbox: tool({
        description:
          "Numbered inbox: requests, responses, and system notices. Answer items with hub_reply <n>.",
        args: {},
        async execute() {
          const items = hub.inbox();
          if (items.length === 0) return "(inbox empty)";
          return items
            .map((m, i) =>
              isNotice(m)
                ? `${i + 1}. (notice) ${m.text}`
                : `${i + 1}. [${m.type}] ${displayName(m.from)}: ${m.text}`,
            )
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
