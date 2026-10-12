Type: research

Status: resolved

## Answer

Primary sources: `bonjour-service` npm page (v1.4.4, publ. ~Aug 2026, ~13.9M wk downloads, pure-TS rewrite of `watson/bonjour`, built on `multicast-dns`); `@homebridge/ciao` npm page (v1.3.12, publ. Oct 2026, ~4M wk downloads, RFC 6762/6763, passes Apple Bonjour Conformance Test); `mafintosh/multicast-dns` README (pure-JS, UDP 5353, API: `query`/`respond`/`destroy`); Bun UDP docs (`Bun.udpSocket`, `addMembership`, `setBroadcast`, `setMulticastTTL`); Node `dgram` docs; AP-isolation/guest-network reports (client isolation + "multicast/broadcast control" filters block UDP 5353 peer-to-peer).

### Comparison

| | mDNS/DNS-SD via `bonjour-service` | UDP broadcast beacons (stdlib `node:dgram`) | Alternatives (rejected for v1) |
|---|---|---|---|
| Libs (Node/Bun, Oct 2026) | `bonjour-service` 1.4.4 — maintained, TS types built in, publish **+ browse**. Underneath `multicast-dns` (mafintosh, stable/slow-moving, no Snyk vulns). Works under Bun via `node:dgram` compat (smoke-test in prototype). | Zero deps: `node:dgram` `setBroadcast(true)` / `Bun.udpSocket`. Hand-rolled ~50 lines. | `node_mdns` (agnat): native bindings to mDNSResponder/avahi — install pain, needs dev headers, bad on Windows. `@homebridge/ciao`: maintained + RFC-strict but **advertise-only, no browse** ("no schedule" for querier) — unusable alone for symmetric discovery. SSDP/UPnP: heavier (HTTPU+XML), no benefit. Central rendezvous/internet relay: out of scope. |
| What each peer learns | SRV → **port**; A/AAAA → **IP**; TXT → **instance id, display name, proto version**; `up`/`down` events → presence. One `publish({name,type:'_opencode-hub._tcp',port,txt})` + `find()` call. | Whatever we put in the JSON beacon: **id, display name, TCP port, version** + sender IP from `rinfo`. Presence must be hand-rolled (heartbeat + expiry). | — |
| Name conflicts | Built-in per RFC 6762 §8–9: probing before announce, loser auto-renames (`Name (2)`). Persist `NAME_CHANGED`. Collision identity still needs TXT instance-id (separate ticket). | Must be hand-rolled (id-keyed peer table, display-name suffix on clash). | — |
| Network pitfalls | UDP 5353 → 224.0.0.251 / ff02::fb. **Blocked by**: guest-WiFi/AP client isolation, AP "multicast/broadcast control" filters, host firewalls (Win Defender/macOS/ufw need UDP-5353 + TCP-msg-port allows), VPNs stealing multicast route, multi-homed hosts (bind per interface). Captive portal irrelevant once joined/authed. Coexisting responders (system mDNSResponder + ours) share 5353 via SO_REUSEADDR — RFC 6762 §15 notes unicast-response limits, negligible for 2-peer probing. | Same WiFi filters often rate-limit/block directed broadcast too — but uses our own fixed port, so only one firewall rule needed and no 5353 dependency. Fails under client isolation all the same. | — |
| Effort | Small: one dep, ~30 lines publish+browse. | Small but re-invents presence/conflicts. | — |

### Recommendation for v1

- **Primary: mDNS/DNS-SD via `bonjour-service`.** Service type e.g. `_opencode-hub._tcp.local`; TXT carries `id` (uuid), `name` (display), `v` (proto), `port` (TCP inbox). Rationale: maintained (Aug 2026 release, 13.9M dl/wk), zero native deps, publish+browse in one lib, conflict resolution + presence events free, Bun-compatible path.
- **Fallback: UDP-broadcast beacons on a fixed port** (stdlib only) + **manual IP entry** as last resort. Same payload fields, 2–5 s heartbeat, timeout-based expiry (~3× interval). Covers WiFis that filter 5353 but pass broadcast, and gives users an escape hatch under client isolation.
- **Reject:** `node_mdns` (native), `ciao`-alone (no browse), SSDP, any central relay.

### Open risks (for transport/pairing tickets)

1. Client-isolated / guest WiFis block ALL peer discovery — fallback can't fix physics; manual IP + user warning needed.
2. Host firewall prompts on first run (both 5353 and TCP inbox port) — installer/run docs must cover Win/macOS/Linux.
3. `bonjour-service` under Bun needs a prototype smoke test (publish on A, browse on B, kill → `down` event).
4. TXT size limit (~1300 B over mDNS) — keep TXT tiny (ids only, no keys/certs); pairing material goes over TCP after discovery.

## Question

How should two opencode instances discover each other automatically on the same LAN (same WiFi)? Compare mDNS/Bonjour (e.g. Zeroconf service advertisement) vs UDP broadcast vs alternatives, in the context of a Node/Bun-based opencode plugin: library availability, firewall/Captive-portal pitfalls, name conflicts, and what each peer learns (IP, port, instance id, display name). Recommend one mechanism + fallback for v1.

Decide only the mechanism facts; the message envelope and pairing flow are separate tickets.
