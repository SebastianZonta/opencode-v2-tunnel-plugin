# 05: Fallback discovery and setup docs

**What to build:** the network never leaves users stranded: where mDNS is filtered, UDP-beacon fallback plus manual IP entry keep discovery working, and setup docs cover firewalls, permissions, and dead-end networks honestly.

**Blocked by:** 02 (LAN discovery between two instances).

**Status:** done (cc28284; 39/39 tests, tsc clean, adapter smoke-tested)

- [ ] UDP-broadcast beacons (stdlib only, same payload fields, 2–5 s heartbeat, ~3× expiry) kick in where mDNS fails
- [ ] `hub add <ip:port>` manual entry as last resort, with client-isolation warning
- [ ] Docs: inbound TCP + UDP 5353 firewall allows (Win/macOS/Linux), subnet-multicast requirement, VPN/multi-homed caveats
- [ ] Permission recommendations (`allow` for `hub_peers`/`hub_inbox`, `ask` for send/reply/pair) + plaintext-on-LAN sniffing warning
