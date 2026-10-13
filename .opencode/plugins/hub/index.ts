import { Plugin } from "@opencode/plugin";
import { BASE_PORT, HubCore, isNotice } from "../../../src/hub";
import { loadHubId } from "../../../src/identity";
import { HubRpc } from "../../../src/hub-rpc";

// One hub per opencode process. This file stays a thin adapter over HubCore
// (tested in src/): tool/input/output shaping only, no messaging logic.
// The id is persisted: pairing memory is keyed on it, so it cannot be
// per-process or every restart looks like a changed peer (spec section 4).
const hub = new HubCore(loadHubId(), "hub");

const displayName = (id: string): string =>
  id === hub.id
    ? `${hub.name} (you)`
    : (hub.peers().find((p) => p.id === id)?.name ?? id.slice(0, 8));

export default Plugin.define({
  id: "hub",
  async setup(ctx) {
    const rpc = await ctx.rpc.register(HubRpc, {});
    // Arrival: emit a live-only RPC event for the CLI companion's toast.
    // Fire-and-forget: a failed emit must never break receipt.
    hub.onMessage = (m) => {
      const name =
        hub.peers().find((p) => p.id === m.from)?.name ?? "unknown peer";
      void rpc.events
        .emit("message", { from: m.from, name, text: m.text })
        .catch(() => {});
    };

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "hub_start",
        description:
          "Start the LAN hub: open the HTTP listener for incoming P2P messages.",
        input: {
          type: "object",
          properties: { port: { type: "number" } },
          additionalProperties: false,
        },
        execute: async (input) => {
          const args = input as { port?: number };
          const port = await hub.start(args.port ?? BASE_PORT);
          return {
            content: `hub listening on ${port} as ${hub.name} (${hub.id})`,
          };
        },
      });

      editor.add({
        name: "hub_stop",
        description: "Stop the LAN hub HTTP listener.",
        input: { type: "object", additionalProperties: false },
        execute: async () => {
          await hub.stop();
          return { content: "hub stopped" };
        },
      });

      editor.add({
        name: "hub_send",
        description:
          "Send a text message to a peer by number or name (see hub_peers); ambiguous names are refused.",
        input: {
          type: "object",
          properties: {
            peer: { type: "string" },
            text: { type: "string" },
          },
          required: ["peer", "text"],
          additionalProperties: false,
        },
        execute: async (input) => {
          const args = input as { peer: string; text: string };
          try {
            const result = await hub.sendToPeer(args.peer, args.text);
            return { content: result.status };
          } catch (e) {
            return { content: e instanceof Error ? e.message : String(e) };
          }
        },
      });

      editor.add({
        name: "hub_reply",
        description:
          "Answer inbox item n (see hub_inbox); the reply fills inReplyTo invisibly.",
        input: {
          type: "object",
          properties: {
            n: { type: "number" },
            text: { type: "string" },
          },
          required: ["n", "text"],
          additionalProperties: false,
        },
        execute: async (input) => {
          const args = input as { n: number; text: string };
          try {
            const result = await hub.reply(args.n, args.text);
            return { content: result.status };
          } catch (e) {
            return { content: e instanceof Error ? e.message : String(e) };
          }
        },
      });

      editor.add({
        name: "hub_inbox",
        description:
          "Numbered inbox: requests, responses, and system notices. Answer items with hub_reply <n>.",
        input: { type: "object", additionalProperties: false },
        execute: async () => {
          const items = hub.inbox();
          if (items.length === 0) return { content: "(inbox empty)" };
          return {
            content: items
              .map((m, i) =>
                isNotice(m)
                  ? `${i + 1}. (notice) ${m.text}`
                  : `${i + 1}. [${m.type}] ${displayName(m.from)}: ${m.text}`,
              )
              .join("\n"),
          };
        },
      });

      editor.add({
        name: "hub_peers",
        description: "List discovered LAN peers: name, paired?, last seen.",
        input: { type: "object", additionalProperties: false },
        execute: async () => {
          const peers = hub.peers();
          if (peers.length === 0)
            return { content: "(no peers discovered yet)" };
          return {
            content: peers
              .map(
                (p, i) =>
                  `${i + 1}. ${p.name} (${p.id.slice(0, 8)}) ` +
                  `paired:${p.paired ? "yes" : "no"} ` +
                  `last-seen:${Math.round((Date.now() - p.lastSeen) / 1000)}s ago`,
              )
              .join("\n"),
          };
        },
      });

      editor.add({
        name: "hub_pair",
        description:
          "Pairing: no code issues a 6-digit single-use 5-minute code for a peer; with code redeems it and trusts the peer.",
        input: {
          type: "object",
          properties: {
            peer: { type: "string" },
            name: { type: "string" },
            code: { type: "string" },
          },
          required: ["peer"],
          additionalProperties: false,
        },
        execute: async (input) => {
          const args = input as { peer: string; name?: string; code?: string };
          if (args.code === undefined) {
            const code = hub.issuePairingCode();
            return {
              content: `pairing code for ${args.peer}: ${code} (single-use, 5 min)`,
            };
          }
          // TOFU is keyed on the peer's real uuid, never the number/name the
          // human typed, or isPaired() never matches and sends stay 403.
          const target = hub.resolvePeer(args.peer);
          const peer = hub.redeemPairingCode(
            args.code,
            target.id,
            args.name ?? target.name,
          );
          return { content: `paired with ${peer.name} (${peer.id})` };
        },
      });

      editor.add({
        name: "hub_unpair",
        description: "Forget a paired peer; their messages will be rejected.",
        input: {
          type: "object",
          properties: { peer: { type: "string" } },
          required: ["peer"],
          additionalProperties: false,
        },
        execute: async (input) => {
          const args = input as { peer: string };
          return {
            content: hub.unpair(args.peer)
              ? `unpaired ${args.peer}`
              : `${args.peer} was not paired`,
          };
        },
      });

      editor.add({
        name: "hub_add",
        description:
          "Manual peer entry (mDNS/UDP fallback): probe ip:port and add the hub found there. Last resort for filtered networks; on client-isolating APs direct IP may be blocked too.",
        input: {
          type: "object",
          properties: { target: { type: "string" } },
          required: ["target"],
          additionalProperties: false,
        },
        execute: async (input) => {
          const args = input as { target: string };
          try {
            const i = args.target.lastIndexOf(":");
            if (i < 0) throw new Error('hub: use "ip:port"');
            const peer = await hub.addPeerFromAddress(
              args.target.slice(0, i),
              Number(args.target.slice(i + 1)),
            );
            return {
              content:
                `added ${peer.name} (${peer.id}) — auto-paired on discovery; ` +
                `note: client-isolating APs may still block direct IP`,
            };
          } catch (e) {
            return { content: e instanceof Error ? e.message : String(e) };
          }
        },
      });
    });

    return () => {
      void hub.stop().catch(() => {});
    };
  },
});
