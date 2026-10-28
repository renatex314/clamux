import fs from "node:fs";
import path from "node:path";
import { SAVED_DIR } from "./paths.js";

export type Agent = "claude" | "agy";

export function parseAgent(v?: string): Agent {
  if (!v || v === "claude") return "claude";
  if (v === "agy" || v === "gemini") return "agy";
  throw new Error(`unknown agent '${v}' (expected 'claude', 'agy', or 'gemini')`);
}

/** What it takes to bring a session back: where it ran, how it was started, and which conversation it held. */
export interface Saved {
  cwd: string;
  agent?: Agent;
  claudeArgs: string[];
  notify: boolean;
  sessionId: string | null;
  transcriptPath: string | null;
  savedAt: number;
}

const file = (name: string) => path.join(SAVED_DIR, `${name}.json`);

export function readSaved(name: string): Saved | null {
  try {
    return JSON.parse(fs.readFileSync(file(name), "utf8")) as Saved;
  } catch {
    return null;
  }
}

export function writeSaved(name: string, rec: Saved): void {
  fs.mkdirSync(SAVED_DIR, { recursive: true });
  const tmp = `${file(name)}.${process.pid}.tmp`; // not *.json, so listings never see it
  fs.writeFileSync(tmp, JSON.stringify(rec));
  fs.renameSync(tmp, file(name));
}

/** Merges fields into an existing record; does nothing for sessions that were never saved. */
export function updateSaved(name: string, fields: Partial<Saved>): void {
  const cur = readSaved(name);
  if (cur) writeSaved(name, { ...cur, ...fields });
}

export function removeSaved(name: string): void {
  fs.rmSync(file(name), { force: true });
}

export function savedNames(): string[] {
  try {
    return fs.readdirSync(SAVED_DIR).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));
  } catch {
    return [];
  }
}
