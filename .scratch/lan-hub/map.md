## Destination

A build-ready spec for an opencode plugin that lets two opencode instances on the **same WiFi** exchange **agent-to-agent text request/response**: automatic discovery + presence, pairing-gated trust, symmetric P2P (no central host), 1-to-1 only. Implementation happens after this map closes.

## Notes

- Domain: P2P LAN messaging. "Hub" = the shared presence view, not a server. "Request" = one agent-task message expecting a reply.
- Skills every session should consult: `grilling`, `domain-modeling`. Research tickets use `research`; the prototype uses `prototype`.
- Standing preferences for this effort: symmetric P2P, no designated host; pairing code required (no open messaging); text-only v1; 1-to-1 only; plugin surface roughly `hub start/stop`, `hub peers`, `hub send <peer> <message>`, inbox for replies.
- Tracker: local markdown per `docs/agents/issue-tracker.md`.

## Decisions so far

<!-- one line per closed ticket: gist + link. Open tickets are NOT listed here. -->
- [plugin capabilities](issues/02-opencode-plugin-capabilities.md): Bun in-process unsandboxed plugin (node:net/dgram OK); listener lives only while opencode runs; hub surface = custom tools + markdown slash commands; poll-based inbox (no push); per-tool permissions; local-dir or npm distribution.
- [lan discovery](issues/01-lan-discovery.md): primary mDNS/DNS-SD via `bonjour-service`, fallback UDP-broadcast beacons + manual IP.
- [transport + envelope](issues/03-transport-envelope.md): symmetric-P2P HTTP+JSON (`POST /v1/messages`), port 41737+increment advertised via mDNS, `{id,from,to,type,inReplyTo,text,ts}` envelope with 64 KB cap, timeout-based presence.
- [pairing + trust](issues/04-pairing-trust.md): 6-digit single-use 5-min pairing code human-relayed; names-only pre-pairing with 403-gated inbox; TOFU peer store with unpair; plaintext-on-LAN v1 with documented sniffing risk.
- [session prototype](issues/05-session-prototype.md): `hub reply <n>` for correlation, toast-on-arrival + poll-while-awaiting, number-or-name addressing with refuse-on-ambiguous. Artifact: [session-transcript.md](../prototype/session-transcript.md).
- [spec assembly](issues/06-spec-assembly.md): destination artifact [spec.md](../spec.md) — no contradictions between tickets; risks carried into §7.

## Not yet specified

- Post-v1 ideas (never tickets in this effort): file transfer, images, context sync, group messaging, cross-network relay, encryption

## Out of scope

- Cross-WiFi / internet relay — excluded by user (Q4)
- File, image, or context sync in v1 — deferred (Q4)
- Group channels / multi-peer broadcast in v1 — deferred (Q5)
- Unauthenticated open messaging — rejected (Q3)
