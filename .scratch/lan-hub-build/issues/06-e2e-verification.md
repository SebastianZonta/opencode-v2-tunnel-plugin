# 06: Two-machine end-to-end verification

**What to build:** the prototype transcript run for real: two machines, one WiFi, full session (start, port clash, pairing, send/reply, timeout, stop) green — clearing the spec's two-machine smoke-test risk.

**Blocked by:** 02 (LAN discovery), 03 (pairing and gated inbox), 04 (replies, addressing, arrival UX).

**Status:** ready-for-agent

- [ ] Two instances discover, pair, exchange request → response, unpair/stop cleanly
- [ ] Second instance on one machine gets incremented port and still works
- [ ] Killed peer times out (no hang); unpaired sender gets 403
- [ ] Result logged (pass/fail per step) against the transcript in `.scratch/lan-hub/prototype/session-transcript.md`
