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
  /** Claude Code account new sessions run under. */
  account?: string;
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

const UI = path.join(HOME_DIR, "ui.json");

/** Groups folded in the dashboard. Only groups that still exist are returned. */
export function readFolded(): Set<string> {
  const groups = readGroups();
  try {
    const v = (JSON.parse(fs.readFileSync(UI, "utf8")) as { folded?: unknown }).folded;
    return new Set(Array.isArray(v) ? v.filter((g): g is string => typeof g === "string" && g in groups) : []);
  } catch {
    return new Set();
  }
}

/** Remembers which groups are folded in the dashboard (groups that no longer exist are dropped). */
export function writeFolded(folded: Iterable<string>): void {
  const groups = readGroups();
  let ui: Record<string, unknown> = {};
  try {
    ui = JSON.parse(fs.readFileSync(UI, "utf8")) as Record<string, unknown>;
  } catch {
    // first write
  }
  ui.folded = [...new Set(folded)].filter((g) => g in groups).sort();
  fs.mkdirSync(HOME_DIR, { recursive: true });
  const tmp = `${UI}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(ui, null, 2));
  fs.renameSync(tmp, UI);
}
