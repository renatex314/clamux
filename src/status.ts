import fs from "node:fs";
import path from "node:path";
import { STATUS_DIR } from "./paths.js";
import { readSaved, savedNames, type Agent } from "./saved.js";

export type HookState = "starting" | "working" | "idle" | "waiting" | "ended";
export type DisplayState = HookState | "dead" | "stale?";

export interface Status {
  state: HookState;
  agent?: Agent;
  tool?: string | null;
  message?: string | null;
  since?: number;
  updated?: number;
  cwd?: string | null;
  session_id?: string | null;
  transcript_path?: string | null;
}

export interface Row {
  name: string;
  agent: Agent;
  state: DisplayState;
  detail: string;
  ageS: number;
  cwd: string;
  live: boolean;
  sessionId: string | null;
  transcriptPath: string | null;
  /** The group the session belongs to, if any. */
  group: string | null;
  /** Not running, but a saved record exists, so `resume` can bring it back. */
  resumable: boolean;
}

/** A "working" status that has not been refreshed for this long is flagged. */
export const STALE_AFTER_S = 15 * 60;

const file = (name: string) => path.join(STATUS_DIR, `${name}.json`);
const nowS = () => Date.now() / 1000;

export function readStatus(name: string): Status | null {
  try {
    return JSON.parse(fs.readFileSync(file(name), "utf8")) as Status;
  } catch {
    return null;
  }
}

/** Merges fields into the session's status file atomically. Returns the previous state. */
export function writeStatus(name: string, fields: Partial<Status>): HookState | undefined {
  fs.mkdirSync(STATUS_DIR, { recursive: true });
  const cur: Partial<Status> = readStatus(name) ?? {};
  const prev = cur.state;
  const now = nowS();
  const next: Partial<Status> = { ...cur, ...fields, updated: now };
  if (fields.state !== undefined && fields.state !== prev) next.since = now;
  const tmp = `${file(name)}.${process.pid}.tmp`; // not *.json, so listings never see it
  fs.writeFileSync(tmp, JSON.stringify(next));
  fs.renameSync(tmp, file(name));
  return prev;
}

export function removeStatus(name: string): void {
  fs.rmSync(file(name), { force: true });
}

export function statusNames(): string[] {
  try {
    return fs.readdirSync(STATUS_DIR).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));
  } catch {
    return [];
  }
}

export function describe(name: string, live: Set<string>): Row {
  const st = readStatus(name);
  const now = nowS();
  const sv = readSaved(name);
  const base = {
    name,
    agent: st?.agent ?? sv?.agent ?? "claude",
    cwd: st?.cwd ?? sv?.cwd ?? "",
    live: live.has(name),
    sessionId: st?.session_id ?? sv?.sessionId ?? null,
    transcriptPath: st?.transcript_path ?? sv?.transcriptPath ?? null,
    group: sv?.group ?? null,
    resumable: !live.has(name) && sv !== null,
  };
  if (!base.live) {
    const state: DisplayState = st && st.state !== "ended" ? "dead" : "ended";
    return { ...base, state, detail: base.resumable ? "resumable" : "", ageS: st?.since ? now - st.since : 0 };
  }
  if (!st) return { ...base, state: "starting", detail: "", ageS: 0 };
  let state: DisplayState = st.state;
  let detail = st.tool ?? "";
  if (state === "waiting") detail = (st.message ?? "").slice(0, 50);
  if (state === "working" && st.updated && now - st.updated > STALE_AFTER_S) {
    state = "stale?";
    detail = `no event for ${fmtAge(now - st.updated)}`;
  }
  return { ...base, state, detail, ageS: now - (st.since ?? now) };
}

export function snapshot(live: Set<string>): Row[] {
  const names = [...new Set([...live, ...statusNames(), ...savedNames()])].sort();
  return names.map((n) => describe(n, live));
}

export function fmtAge(secs: number): string {
  const s = Math.max(0, Math.floor(secs));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}
