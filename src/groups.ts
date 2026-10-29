import fs from "node:fs";
import path from "node:path";
import { HOME_DIR } from "./paths.js";
import type { Agent } from "./saved.js";

/** Defaults for the sessions created in a group; anything left out falls back to the usual default. */
export interface Group {
  /** Directory new sessions start in. */
  dir?: string;
  /** Desktop notification when a session finishes or needs input. */
  notify?: boolean;
  agent?: Agent;
  /** Extra arguments for the agent CLI. */
  args?: string[];
}

const GROUPS = path.join(HOME_DIR, "groups.json");

export function readGroups(): Record<string, Group> {
  try {
    const v = JSON.parse(fs.readFileSync(GROUPS, "utf8")) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, Group>) : {};
  } catch {
    return {};
  }
}

export function writeGroups(groups: Record<string, Group>): void {
  fs.mkdirSync(HOME_DIR, { recursive: true });
  const tmp = `${GROUPS}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(groups, null, 2));
  fs.renameSync(tmp, GROUPS);
}
