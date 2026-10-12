export interface PeerInfo {
  id: string;
  name: string;
  port: number;
  addresses: string[];
  lastSeen: number;
}

export interface PeerAnnouncement {
  id: string;
  name: string;
  port: number;
  addresses?: string[];
  lastSeen?: number;
}

// Presence keyed on TXT id, never the display name. Shared by mDNS
// up/down events (ticket 02) and UDP-beacon heartbeats (ticket 05);
// the sweep is the backstop for peers that vanish without goodbye.
export class PeerRegistry {
  private peers = new Map<string, PeerInfo>();

  constructor(private timeoutMs = 30_000) {}

  upsert(a: PeerAnnouncement): void {
    this.peers.set(a.id, {
      id: a.id,
      name: a.name,
      port: a.port,
      addresses: a.addresses ?? [],
      lastSeen: a.lastSeen ?? Date.now(),
    });
  }

  remove(id: string): void {
    this.peers.delete(id);
  }

  clear(): void {
    this.peers.clear();
  }

  list(now = Date.now()): PeerInfo[] {
    const out: PeerInfo[] = [];
    for (const [id, p] of this.peers) {
      if (now - p.lastSeen > this.timeoutMs) this.peers.delete(id);
      else out.push({ ...p });
    }
    return out;
  }
}
