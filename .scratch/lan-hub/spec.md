# Spec: LAN Hub — P2P agent-to-agent messaging opencode plugin

**Status:** build-ready. **Scope:** same-WiFi, text-only, 1-to-1, opencode plugin.
Source decisions: [01](issues/01-lan-discovery.md) [02](issues/02-opencode-plugin-capabilities.md) [03](issues/03-transport-envelope.md) [04](issues/04-pairing-trust.md) [05](issues/05-session-prototype.md), [transcript](../prototype/session-transcript.md).

## 1. Topology

Symmetric P2P mesh, no central host. Every opted-in opencode instance runs its own
HTTP server + discovery client. "Hub" is the shared presence view, not a server.
Either machine may vanish at any time; presence is timeout-based throughout.

## 2. Discovery

- **Primary: mDNS/DNS-SD** via `bonjour-service` (pure TS, publish + browse).
  Service type `_opencode-hub._tcp.local`. TXT record carries only
  `id=<instance-uuid>`, `name=<display-name>`, `v=<proto-version>`
  (TXT budget ~1300 B — ids only, never keys or payloads).
  Port is learned from SRV, IP from A/AAAA; `up`/`down` events drive presence.
  Name conflicts resolve per RFC 6762 (probing + auto-rename); identity is the
  TXT `id`, never the display name.
- **Fallback: UDP-broadcast beacons** (stdlib `node:dgram`, fixed port) with the
  same payload fields, 2–5 s heartbeat, expiry at ~3× interval.
- **Last resort: manual IP entry** (`hub add <ip:port>`), for client-isolated
  guest WiFis where no broadcast mechanism works.

## 3. Transport + envelope

- Each peer serves **HTTP + JSON**; sends are `POST /v1/messages`.
- **Port:** default `41737`, auto-increment on `EADDRINUSE` (two instances, one
  machine). The bound port is what mDNS advertises — peers never guess.
- **Envelope** (JSON body, `Content-Type: application/json`):

| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | string (uuid) | yes | Unique id of this message |
| `from` | string (instance id) | yes | Sender id (matches mDNS TXT `id`) |
| `to` | string (instance id) | yes | Recipient id; receiver drops mismatches |
| `type` | `request` \| `response` \| `error` | yes | Message kind |
| `inReplyTo` | string (uuid) | for `response`/`error` | Request `id` being answered |
| `text` | string, ≤ 64 KB UTF-8 | yes | Agent message; over-limit senders split or refuse |
| `ts` | string (ISO-8601) | yes | Sender timestamp, informational |

- Flow: `request` → `response` (or `error`) correlated by `inReplyTo`.
  Receiver queues into the poll-based inbox and replies `200 {"status":"queued"}`.
- **Liveness:** mDNS `down` or missed heartbeats (~3× interval) marks a peer gone;
  unanswered requests expire locally with a timeout error. No infinite retry,
  no graceful-leave guarantee.

## 4. Pairing + trust

- **Flow:** `hub pair <peer>` shows a **6-digit, 5-minute, single-use code**;
  humans relay it out-of-band; the other side submits `hub pair <code>`.
- **Pre-pairing:** display name + instance id visible (mDNS already broadcasts
  them). `POST /v1/messages` from an unpaired id → HTTP `403`. No content flows
  before pairing.
- **Memory (TOFU):** paired ids persist in `~/.config/opencode/hub-peers.json`
  (`{id, name, pairedAt}`). Known ids skip pairing; unknown/changed ids re-pair;
  `hub unpair <peer>` forgets.
- **Encryption:** **none in v1 — plaintext HTTP on the LAN, gated by pairing.**
  ⚠️ Hostile WiFi (café, hotel) can be sniffed: users must treat v1 as
  postcard-grade privacy. Encryption is the first post-v1 item.

## 5. Plugin surface

Target the **v1 plugin API** (`@opencode-ai/plugin` named-export functions;
Bun runtime, unsandboxed, `node:net` + `node:dgram` available).

**Agent tools** (stable `hub_*` keys):

| Tool | Args | Effect |
|---|---|---|
| `hub_start` | — | Open HTTP listener + publish mDNS, become visible |
| `hub_stop` | — | Unpublish, close listener (TOFU store kept) |
| `hub_peers` | — | Numbered peer list: name, paired?, last seen |
| `hub_pair` | `peer?`, `code?` | No code: show new code for peer. With code: submit pairing |
| `hub_unpair` | `peer` | Forget a paired peer |
| `hub_send` | `peer` (number or name), `text` | Send `request`; ambiguous names refused, never guessed |
| `hub_reply` | `n`, `text` | Answer inbox item n; plugin fills `inReplyTo` |
| `hub_inbox` | — | Numbered inbox: requests, responses, system notices |

**Human path:** thin `/hub` slash-command markdown files invoking the tools
(`/hub start|peers|send|inbox|…`); the listener lives only while opencode runs.
**Arrival UX:** plugin fires `tui.toast.show` on incoming messages; agent
convention is "poll `hub inbox` each turn while awaiting a reply" (no push API
exists — inbox latency equals poll cadence).

**Permissions:** recommend `allow` for read-only (`hub_peers`, `hub_inbox`),
`ask` (user-tunable to `allow`) for `hub_send` / `hub_reply` / `hub_pair`.

## 6. Packaging + setup

- Ship as **local dir** (`.opencode/plugins/` or `~/.config/opencode/plugins/`)
  or **npm package** (config `plugin: [...]`, Bun auto-installs at startup).
  Deps: `bonjour-service` (+ transitive `multicast-dns`).
- **Setup notes (must document):** allow inbound TCP on the hub port and UDP
  5353 through Win Defender / macOS / ufw on first run; same-subnet multicast
  required; VPNs may steal the multicast route; multi-homed hosts must bind per
  interface; client-isolated guest networks block everything (manual IP + warning).

## 7. Open risks

1. `bonjour-service`-under-Bun needs a two-machine smoke test (publish on A,
   browse on B, kill → `down`).
2. Poll-based inbox UX untested with real agents (latency tolerance).
3. Concurrent instances on one machine (port increment + separate TOFU identity).
4. Plaintext-on-LAN accepted risk (see §4 warning).
