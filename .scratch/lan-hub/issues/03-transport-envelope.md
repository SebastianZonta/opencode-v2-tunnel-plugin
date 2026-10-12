Type: grilling

Status: resolved

Blocked by: 01, 02

## Question

Given the discovery mechanism ([lan discovery](01-lan-discovery.md)) and plugin capabilities ([plugin capabilities](02-opencode-plugin-capabilities.md)), decide the v1 transport + message envelope: WebSocket vs plain HTTP vs raw TCP; who dials whom; port selection and advertisement; presence heartbeat; request/response correlation ids; text-only envelope schema (fields, size limits); error and retry semantics. Produce the decided envelope (field table) as the resolution.

Call the Skill tool for `grilling` and `domain-modeling` while resolving.

## Answer

Decided 2026-10-12 (grilling, user-confirmed Q1–Q4).

- **Transport:** symmetric-P2P HTTP + JSON. Every opted-in instance runs a tiny HTTP server (Bun.serve / node:http) and dials peers; sends are `POST /v1/messages`. No WebSockets, no raw TCP framing. Rationale: matches request/response shape, curl-debuggable, agent inbox stays poll-based regardless.
- **Port:** default `41737`; on `EADDRINUSE` auto-increment until free (covers two instances on one machine). The bound port is what mDNS advertises (SRV) — peers never guess.
- **Liveness:** timeout-based. mDNS `down` or missed heartbeats (~3× interval) marks a peer gone; no graceful-leave guarantee. Unanswered requests expire locally with a timeout error, no infinite retry.

### v1 envelope (JSON body of `POST /v1/messages`, `Content-Type: application/json`)

| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | string (uuid) | yes | Unique id of this message |
| `from` | string (instance id) | yes | Sender instance id (matches mDNS TXT `id`) |
| `to` | string (instance id) | yes | Intended recipient instance id; receiver drops mismatches |
| `type` | `request` \| `response` \| `error` | yes | Message kind |
| `inReplyTo` | string (uuid) | for `response`/`error` | Request `id` being answered |
| `text` | string, ≤ 64 KB UTF-8 | yes | The agent message; over-limit senders must split or refuse |
| `ts` | string (ISO-8601) | yes | Sender timestamp; informational only |

Flow: `request` → `response` (or `error`) correlated by `inReplyTo`. Receiver enqueues into the poll-based `hub_inbox` queue; delivery while the peer's opencode is closed is impossible (presence timeout covers it).
