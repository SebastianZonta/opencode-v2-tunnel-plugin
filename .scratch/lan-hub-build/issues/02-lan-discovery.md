# 02: LAN discovery between two instances

**What to build:** two opencode instances on one WiFi see each other: each publishes mDNS `_opencode-hub._tcp.local` (TXT: id, name, version) and `hub peers` lists the other with its advertised port; a vanished peer clears via timeout/`down` event.

**Blocked by:** 01 (skeleton plugin with loopback messaging).

**Status:** done (15/15 bun tests, tsc clean)

- [x] mDNS publish + browse via `bonjour-service`; port learned from SRV, never guessed
- [x] `hub peers` shows name, paired?, last seen for each discovered instance
- [x] Name conflicts auto-resolve (RFC 6762); identity keyed on TXT `id`
- [x] Peer gone (process killed) disappears within ~3× heartbeat interval
