import { describe, test, expect } from "bun:test";
import { PeerRegistry } from "./peers";

describe("PeerRegistry", () => {
  test("upsert is keyed on id: re-announce updates, never duplicates", () => {
    const reg = new PeerRegistry(30_000);
    reg.upsert({ id: "a", name: "A", port: 41737, lastSeen: 1000 });
    reg.upsert({ id: "a", name: "A-renamed", port: 41738, lastSeen: 2000 });
    const list = reg.list(2000);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: "a", name: "A-renamed", port: 41738 });
  });

  test("remove drops the peer", () => {
    const reg = new PeerRegistry(30_000);
    reg.upsert({ id: "a", name: "A", port: 41737, lastSeen: 1000 });
    reg.remove("a");
    expect(reg.list(1000)).toHaveLength(0);
  });

  test("entries older than the timeout are swept on list", () => {
    const reg = new PeerRegistry(1000);
    reg.upsert({ id: "old", name: "O", port: 41737, lastSeen: 0 });
    reg.upsert({ id: "new", name: "N", port: 41738, lastSeen: 1500 });
    const list = reg.list(2000);
    expect(list.map((p) => p.id)).toEqual(["new"]);
  });

  test("re-upsert refreshes lastSeen and keeps the peer alive", () => {
    const reg = new PeerRegistry(1000);
    reg.upsert({ id: "a", name: "A", port: 41737, lastSeen: 0 });
    reg.upsert({ id: "a", name: "A", port: 41737, lastSeen: 1500 });
    expect(reg.list(2000).map((p) => p.id)).toEqual(["a"]);
  });

  test("clear empties the registry", () => {
    const reg = new PeerRegistry(30_000);
    reg.upsert({ id: "a", name: "A", port: 41737, lastSeen: 1000 });
    reg.clear();
    expect(reg.list(1000)).toHaveLength(0);
  });
});
