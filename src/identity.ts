import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export const defaultHubIdPath = () =>
  join(homedir(), ".config", "opencode", "hub-id.json");

// Pairing memory is keyed on the instance id (spec section 4), so the id has to
// outlive the process: a fresh id per launch reads as a changed peer and forces
// re-pairing.
export function loadHubId(path: string = defaultHubIdPath()): string {
  try {
    const rec: unknown = JSON.parse(readFileSync(path, "utf8"));
    const id = (rec as Record<string, unknown> | null)?.id;
    if (typeof id === "string" && id !== "") return id;
  } catch {
    // missing or corrupt: mint a new id below
  }
  const id = randomUUID();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ id }, null, 2));
  return id;
}
