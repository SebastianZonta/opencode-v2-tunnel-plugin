Type: grilling

Status: resolved

Blocked by: 03

## Question

Decide the v1 pairing + trust model on top of the transport ([transport + envelope](03-transport-envelope.md)): pairing-code flow (show/enter, code entropy, expiry), what presence discloses before pairing vs after, persistence of paired peers (TOFU store, re-pair policy), whether payloads are encrypted in v1 (TLS/shared secret/Noise vs plaintext-on-LAN with justification), and replay/misbinding protections. Produce the decided flow as the resolution.

Call the Skill tool for `grilling` and `domain-modeling` while resolving.

## Answer

Decided 2026-10-12 (grilling, user-confirmed Q1–Q4).

- **Pairing flow:** initiator runs `hub_pair` → 6-digit code, 5-minute expiry, single-use. Humans relay the digits out-of-band (voice/chat/shoulder-surf); the other agent submits via `hub_pair <code>`. No QR, no key copy-paste.
- **Pre-pairing disclosure:** display name + instance id only (what mDNS already broadcasts). `POST /v1/messages` from an unpaired instance id → HTTP `403`. No content flows before pairing.
- **Memory (TOFU):** paired instance ids persist in a local store (e.g. `~/.config/opencode/hub-peers.json`). Known id reconnects skip pairing; unknown/changed id re-pairs; `hub_unpair <peer>` forgets.
- **Encryption v1:** plaintext HTTP on the LAN, gated by pairing. No TLS/HMAC. The spec must document the sniffing risk (hostile WiFi) openly; encryption is post-v1 fog.
