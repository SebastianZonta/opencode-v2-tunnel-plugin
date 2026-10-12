import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadHubId } from "./identity";

const UUID = /^[0-9a-f-]{36}$/;
const tmpFile = () => join(mkdtempSync(join(tmpdir(), "hub-id-")), "hub-id.json");

describe("stable hub identity", () => {
  test("the same id comes back on every load (survives a restart)", () => {
    const path = tmpFile();
    const first = loadHubId(path);
    expect(first).toMatch(UUID);
    expect(loadHubId(path)).toBe(first);
  });

  test("a corrupt or empty store mints a fresh id", () => {
    const path = tmpFile();
    writeFileSync(path, "{not json");
    const minted = loadHubId(path);
    expect(minted).toMatch(UUID);
    writeFileSync(path, JSON.stringify({ id: "" }));
    expect(loadHubId(path)).not.toBe(minted);
  });
});
