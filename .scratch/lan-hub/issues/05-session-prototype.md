Type: prototype

Status: resolved

Blocked by: 03, 04

## Question

Make a cheap, rough, concrete artifact to react to: a faked end-to-end session transcript (terminal captures and/or stub command handlers) showing `hub start`, `hub peers`, pairing, `hub send` + reply, and opt-out — built only from the decided transport ([transport + envelope](03-transport-envelope.md)) and trust ([pairing + trust](04-pairing-trust.md)). Link the artifact as an asset. The goal is to expose UX awkwardness before the spec is written, not to build the plugin.

Call the Skill tool for `prototype` while resolving (HITL: work with the human, don't answer your own UX questions).

## Answer

Prototype artifact: [session-transcript.md](../prototype/session-transcript.md) (throwaway; no git repo here, so the file itself is the captured asset, not a branch).

Decided 2026-10-12 (HITL, user-confirmed Q1–Q3):

- **Replies:** `hub reply <n> "…"` answers inbox item n; the plugin fills `inReplyTo` from the stored request id. Raw uuids never appear in UX.
- **Arrival:** plugin fires a `tui.toast.show` notification on incoming messages; convention is "if you await a reply, poll `hub inbox` each turn." No push into the agent (capability limit stands).
- **Addressing:** `hub peers` numbers peers; `hub send` accepts the number or the display name as alias; ambiguous names are refused, never guessed.

These graduate into the spec (ticket 06). The transcript's remaining warts (poll latency, timeout expiry, port auto-increment) behave as decided in 03–04 — no new tickets.
