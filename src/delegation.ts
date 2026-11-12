import fs from "node:fs";
import path from "node:path";
import { HOME_DIR } from "./paths.js";
import { pidAlive } from "./registry.js";
import { selfName } from "./identity.js";

/**
 * A session that is waiting on another one: its agent called `ask` / `wait_for_session` (MCP or SDK) on a
 * second session. Without this the waiting session can look idle (or stale) although it is mid-task.
 *
 * The caller is known from CLAMUX_NAME, which every session host sets and the agent's MCP servers and
 * shell commands inherit. One file per pending call; it is removed when the call returns, and ignored
 * (and cleaned up) once the calling process is gone, the target stopped, or the call's timeout passed.
 */
export const DELEGATIONS_DIR = path.join(HOME_DIR, "delegations");

interface Delegation {
  from: string;
  to: string;
  pid: number;
  startedAt: number;
  /** Epoch ms after which the record is ignored even if the caller is still around. */
  until: number | null;
}

/** Grace on top of the caller's own timeout before a leftover record is ignored. */
const SLACK_MS = 60_000;
let seq = 0;

/** Runs `fn` with the current session (if any) recorded as waiting on `to`. */
export async function delegating<T>(to: string, timeoutMs: number | undefined, fn: () => Promise<T>): Promise<T> {
  const from = selfName();
  if (!from || from === to) return fn();
  const file = path.join(DELEGATIONS_DIR, `${process.pid}-${++seq}.json`);
  const now = Date.now();
  const rec: Delegation = { from, to, pid: process.pid, startedAt: now, until: timeoutMs === undefined ? null : now + timeoutMs + SLACK_MS };
  try {
    fs.mkdirSync(DELEGATIONS_DIR, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(rec));
  } catch {
    return fn(); // status display only; never fail the call over it
  }
  try {
    return await fn();
  } finally {
    fs.rmSync(file, { force: true });
  }
}

/** Active delegations by caller: the sessions each one waits on, and since when. */
export function readDelegations(live: Set<string>): Map<string, { to: string[]; since: number }> {
  const out = new Map<string, { to: string[]; since: number }>();
  let files: string[];
  try {
    files = fs.readdirSync(DELEGATIONS_DIR).filter((f) => f.endsWith(".json"));
  } catch {
    return out;
  }
  const now = Date.now();
  for (const f of files) {
    const p = path.join(DELEGATIONS_DIR, f);
    let d: Delegation;
    try {
      d = JSON.parse(fs.readFileSync(p, "utf8")) as Delegation;
    } catch {
      continue;
    }
    if (!pidAlive(d.pid)) {
      fs.rmSync(p, { force: true });
      continue;
    }
    if (!live.has(d.to) || !live.has(d.from) || (d.until !== null && now > d.until)) continue;
    const cur = out.get(d.from) ?? { to: [], since: d.startedAt };
    if (!cur.to.includes(d.to)) cur.to.push(d.to);
    cur.since = Math.min(cur.since, d.startedAt);
    out.set(d.from, cur);
  }
  return out;
}
