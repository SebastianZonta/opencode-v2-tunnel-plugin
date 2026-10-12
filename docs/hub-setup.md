# Hub setup: networks, firewalls, permissions

The hub talks to peers over the LAN in plaintext (see "Plaintext" below).
Discovery is automatic where the network allows it, manual where it does not.

## What must be reachable

| Traffic | Port | Purpose |
|---|---|---|
| Inbound TCP | 41737–41836 (first free wins) | Message HTTP API |
| UDP | 5353 | mDNS discovery |
| UDP in/out | 41837 | Beacon fallback discovery |

mDNS and beacons both feed the same peer list, so on a healthy LAN you do
nothing. Where mDNS is filtered (some routers, corporate APs), the UDP
beacons on 41837 keep discovery working with no action from you.

## Firewalls

- **Linux (ufw):** `sudo ufw allow 41737:41836/tcp && sudo ufw allow 5353/udp && sudo ufw allow 41837/udp`
- **macOS:** allow incoming connections for your terminal/Bun runtime when the
  system firewall prompts on first start.
- **Windows:** allow inbound TCP for Bun/Node on first start via the Defender
  Firewall prompt; mDNS (UDP 5353) is usually already allowed.

If `hub_peers` stays empty, check the firewall first, then read on.

## Networks that break discovery

- **Same subnet + multicast required.** mDNS only works inside one broadcast
  domain. Peers on different VLANs/subnets will not see each other.
- **VPNs** typically route multicast out the wrong interface or drop it. Either
  disconnect the VPN or use `hub_add` with the peer's LAN address.
- **Multi-homed machines** (Wi-Fi + Ethernet + Docker bridges): the hub
  advertises all non-internal IPv4 addresses and peers prefer a LAN-reachable
  one, but if the wrong interface wins, use `hub_add` with the right address.
- **Guest / client-isolating Wi-Fi** blocks peer-to-peer traffic entirely.
  This is a dead end: even `hub_add <ip:port>` fails there, because the AP
  drops the packets, not just discovery. Move both machines to the main LAN.

## Manual entry

```
hub_add 192.168.1.42:41737
```

probes that address for a hub and adds it under its real identity, so pairing
works exactly as with discovered peers. Pair before messaging, as usual.
Warning: on client-isolating APs direct IP is filtered too — see above.

## After a restart

Your instance id (`~/.config/opencode/hub-id.json`) and the address each paired
peer was last seen at (`hub-peers.json`) both survive restarts, so starting the
hub again re-probes your paired peers and reconnects without a new pairing code —
also on networks where mDNS and beacons are filtered. If a peer moved (DHCP) or
took a new port, discovery has to find it again, otherwise `hub_add` it.

## Permissions (your opencode config)

- `allow`: `hub_peers`, `hub_inbox` (read-only, no side effects).
- `ask`: `hub_send`, `hub_reply` (messages leave the machine),
  `hub_pair` / `hub_unpair` (changes who is trusted),
  `hub_start` / `hub_stop`, `hub_add` (network state changes).

## Plaintext on LAN

v1 has no encryption: pairing gates *who* may message you, but anyone on the
LAN can sniff message contents off the wire. Same-Wi-Fi trust is the whole
security model. Do not send passwords, tokens, or anything you would not read
aloud in the room. Anything stronger (TLS, keys) is future work, not v1.
