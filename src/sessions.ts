import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ErrorCode } from "./errors.js";
import { childEnv } from "./env.js";
import type { HostConfig } from "./host.js";
import { connect, readMessages, send } from "./ipc.js";
import { keyToBytes } from "./keys.js";
import { HOME_DIR, RUN_DIR, SETTINGS, configFile, errorFile, screenFile, selfPath } from "./paths.js";
import { liveSessions, pidAlive, readRegistry, removeRunFiles } from "./registry.js";
import { parseAgent, readSaved, removeSaved, savedNames, writeSaved, type Agent } from "./saved.js";
import { readStatus, removeStatus, statusNames, writeStatus } from "./status.js";

export { liveSessions } from "./registry.js";
export { parseAgent, type Agent } from "./saved.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type Result = { ok: true } | { ok: false; error: string; code: ErrorCode };
export const fail = (code: ErrorCode, error: string): Result => ({ ok: false, code, error });

/** Default size of a detached session; attaching resizes it to the client's terminal. */
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 40;

export const validName = (n: string) => /^[A-Za-z0-9_-]{1,32}$/.test(n);

export function expandDir(dir: string): string {
  const d = dir.startsWith("~") ? path.join(os.homedir(), dir.slice(1)) : dir;
  return path.resolve(d);
}

function hookCommand(event?: string): string {
  const cli = selfPath();
  const winPath = cli.replace(/\\/g, "/");
  const base = process.platform === "win32"
    ? `node ${winPath.includes(" ") ? `"${winPath}"` : winPath} hook`
    : `'${process.execPath.replace(/'/g, `'\\''`)}' '${cli.replace(/'/g, `'\\''`)}' hook`;
  return event ? `${base} ${event}` : base;
}

/**
 * Settings file handed to `claude --settings`; registers the status hooks for clamux sessions only.
 * The command must parse in every shell Claude Code may use for hooks (bash, cmd, PowerShell), so on
 * Windows it is a plain `node "path" hook` with forward slashes.
 */
export function writeSettings(): void {
  const events = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Notification", "Stop", "SessionEnd"];
  const command = hookCommand();
  const hooks = Object.fromEntries(events.map((e) => [e, [{ hooks: [{ type: "command", command }] }]]));
  fs.mkdirSync(HOME_DIR, { recursive: true });
  fs.writeFileSync(SETTINGS, JSON.stringify({ hooks }, null, 2));
}

export const agyHooksFile = () => path.join(os.homedir(), ".gemini", "config", "hooks.json");

/**
 * Merges clamux's lifecycle hooks into `~/.gemini/config/hooks.json` for Antigravity CLI (`agy`).
 * Sessions not started by clamux lack `CLAMUX_NAME` in their environment, so the hook is a no-op there.
 * Throws, without writing, if the file exists but cannot be parsed: rewriting it would drop the user's own hooks.
 */
export function writeAgyHooks(): void {
  const file = agyHooksFile();
  let root: Record<string, unknown> = {};
  let raw: string | null = null;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  if (raw !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`${file} is not valid JSON; fix it (or delete it) so clamux can add its status hooks`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${file} is not a JSON object; fix it (or delete it) so clamux can add its status hooks`);
    }
    root = parsed as Record<string, unknown>;
  }
  root.clamux = {
    SessionStart: [{ type: "command", command: hookCommand("SessionStart") }],
    PreInvocation: [{ type: "command", command: hookCommand("PreInvocation") }],
    PostToolUse: [{ matcher: "*", hooks: [{ type: "command", command: hookCommand("PostToolUse") }] }],
    Stop: [{ type: "command", command: hookCommand("Stop") }],
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(root, null, 2));
}

export function removeAgyHooks(): boolean {
  const file = agyHooksFile();
  try {
    const root = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    if (!("clamux" in root)) return false;
    delete root.clamux;
    if (Object.keys(root).length === 0) fs.rmSync(file, { force: true });
    else fs.writeFileSync(file, JSON.stringify(root, null, 2));
    return true;
  } catch {
    return false;
  }
}

/** Starts a detached host process for the session and waits until it is serving. */
export async function createSession(
  name: string,
  dir: string,
  opts: { notify: boolean; agent?: Agent | "gemini"; claudeArgs?: string[] },
): Promise<Result> {
  if (!validName(name)) return fail("INVALID", "name may only contain letters, digits, - and _ (max 32 characters)");
  if (liveSessions().has(name)) return fail("EXISTS", `session '${name}' already exists`);
  if (readSaved(name)) return fail("EXISTS", `session '${name}' is saved; resume it, or forget it to reuse the name`);
  const cwd = expandDir(dir);
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) return fail("INVALID", `not a directory: ${cwd}`);
  let agent: Agent;
  try {
    agent = parseAgent(opts.agent);
  } catch (e) {
    return fail("INVALID", e instanceof Error ? e.message : String(e));
  }

  const claudeArgs = opts.claudeArgs ?? [];
  // Saved before the host starts, so the first hook (which records the conversation id) finds it.
  writeSaved(name, { cwd, agent, claudeArgs, notify: opts.notify, sessionId: null, transcriptPath: null, savedAt: Date.now() / 1000 });
  const r = await startHost(name, cwd, agent, claudeArgs, opts.notify);
  if (!r.ok) removeSaved(name);
  return r;
}

/** Arguments that pick a conversation; a resume supplies its own. */
function withoutConversationArgs(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === "--continue" || a === "-c") continue;
    if (a === "--resume" || a === "-r" || a === "--session-id" || a === "--conversation") {
      if (args[i + 1] && !args[i + 1]!.startsWith("-")) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

export type ResumeResult = { ok: true; resumed: boolean } | Extract<Result, { ok: false }>;

/**
 * Restarts a saved session that is not running (killed, or lost to a reboot or crash), continuing its
 * conversation. If no conversation was ever recorded, it starts fresh with the same settings.
 */
export async function resumeSession(name: string): Promise<ResumeResult> {
  const sv = readSaved(name);
  if (!sv) return fail("NOT_FOUND", `no saved session '${name}'`) as Extract<Result, { ok: false }>;
  if (liveSessions().has(name)) return fail("EXISTS", `session '${name}' is already running`) as Extract<Result, { ok: false }>;
  if (!fs.existsSync(sv.cwd) || !fs.statSync(sv.cwd).isDirectory()) {
    return fail("INVALID", `directory is gone: ${sv.cwd}`) as Extract<Result, { ok: false }>;
  }
  const agent: Agent = sv.agent ?? "claude";
  // Transcripts exist once a prompt was sent; resuming an empty session errors out.
  const resumable = sv.sessionId !== null && sv.transcriptPath !== null && fs.existsSync(sv.transcriptPath);
  const resumeFlag = agent === "agy" ? "--conversation" : "--resume";
  const args = resumable ? [...withoutConversationArgs(sv.claudeArgs), resumeFlag, sv.sessionId as string] : sv.claudeArgs;
  const r = await startHost(name, sv.cwd, agent, args, sv.notify);
  return r.ok ? { ok: true, resumed: resumable } : (r as Extract<Result, { ok: false }>);
}

/** Deletes everything clamux keeps about a session that is not running, including its saved record. */
export function forgetSession(name: string): Result {
  if (liveSessions().has(name)) return fail("BUSY", `'${name}' is running; kill it first`);
  const known = readSaved(name) !== null || readStatus(name) !== null;
  if (!known) return fail("NOT_FOUND", `no session '${name}'`);
  removeSaved(name);
  removeStatus(name);
  removeRunFiles(name);
  return { ok: true };
}

/** Removes status entries of sessions that are neither running nor saved. Returns their names. */
export function cleanStale(): string[] {
  const live = liveSessions();
  const saved = new Set(savedNames());
  const stale = statusNames().filter((n) => !live.has(n) && !saved.has(n));
  stale.forEach(removeStatus);
  return stale;
}

async function startHost(name: string, cwd: string, agent: Agent, claudeArgs: string[], notify: boolean): Promise<Result> {
  if (agent === "agy") {
    try {
      writeAgyHooks();
    } catch (e) {
      return fail("HOST_FAILED", e instanceof Error ? e.message : String(e));
    }
  } else writeSettings();
  removeStatus(name);
  removeRunFiles(name);
  fs.mkdirSync(RUN_DIR, { recursive: true });
  const cfg: HostConfig = { cwd, agent, claudeArgs, cols: DEFAULT_COLS, rows: DEFAULT_ROWS };
  fs.writeFileSync(configFile(name), JSON.stringify(cfg));

  const host = spawn(process.execPath, [selfPath(), "host", name], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    cwd,
    env: childEnv({ CLAMUX_NAME: name, CLAMUX_NOTIFY: notify ? "1" : "0" }),
  });
  let hostExited = false;
  host.on("exit", () => (hostExited = true));
  host.on("error", () => (hostExited = true));
  host.unref();

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (readRegistry(name)) {
      writeStatus(name, { state: "starting", agent, cwd, tool: null });
      return { ok: true };
    }
    if (hostExited) break;
    await sleep(50);
  }
  let reason = "session host did not start";
  try {
    reason = fs.readFileSync(errorFile(name), "utf8");
  } catch {
    // keep the generic message
  }
  removeRunFiles(name);
  return fail("HOST_FAILED", reason);
}

/** Plain text of the session's visible screen (refreshed by the host a few times per second). */
export function capturePane(name: string): string {
  try {
    return fs.readFileSync(screenFile(name), "utf8");
  } catch {
    return "";
  }
}

/** The session's screen right now, asked of the host directly (`capturePane` can trail by ~120ms). */
export async function fetchScreen(name: string): Promise<{ ok: true; text: string } | Extract<Result, { ok: false }>> {
  const info = readRegistry(name);
  if (!info || !pidAlive(info.pid)) return fail("NOT_FOUND", `no live session '${name}'`) as Extract<Result, { ok: false }>;
  try {
    const sock = await connect(info.endpoint);
    return await new Promise((resolve) => {
      const timer = setTimeout(() => { sock.destroy(); resolve(fail("HOST_FAILED", "session host did not answer") as Extract<Result, { ok: false }>); }, 2000);
      readMessages(sock, (m) => {
        if (m.t !== "screen") return;
        clearTimeout(timer);
        sock.destroy();
        resolve({ ok: true, text: String(m.d ?? "") });
      });
      send(sock, { t: "screen" });
    });
  } catch (e) {
    return fail("HOST_FAILED", e instanceof Error ? e.message : String(e)) as Extract<Result, { ok: false }>;
  }
}

async function sendFrames(name: string, frames: Array<{ d: string; delayMs?: number }>): Promise<Result> {
  const info = readRegistry(name);
  if (!info || !pidAlive(info.pid)) return fail("NOT_FOUND", `no live session '${name}'`);
  try {
    const sock = await connect(info.endpoint);
    for (const f of frames) {
      if (f.delayMs) await sleep(f.delayMs);
      send(sock, { t: "input", d: f.d });
    }
    await new Promise<void>((resolve) => sock.end(resolve));
    return { ok: true };
  } catch (e) {
    return fail("HOST_FAILED", e instanceof Error ? e.message : String(e));
  }
}

export function sendPrompt(name: string, text: string): Promise<Result> {
  // Enter goes in a separate write so the TUI has ingested the text first.
  return sendFrames(name, [{ d: text }, { d: "\r", delayMs: 300 }]);
}

/** Sends raw key names (e.g. "Enter", "Down", "C-c") or literal text. */
export function pressKeys(name: string, keys: string[]): Promise<Result> {
  return sendFrames(name, keys.map((k) => ({ d: keyToBytes(k) })));
}

export async function killSession(name: string): Promise<Result> {
  const info = readRegistry(name);
  if (!info || !pidAlive(info.pid)) return fail("NOT_FOUND", `no live session '${name}'`);
  try {
    const sock = await connect(info.endpoint, 1000);
    send(sock, { t: "kill" });
    sock.end();
  } catch {
    // fall through to the hard kill
  }
  for (let i = 0; i < 40 && pidAlive(info.pid); i++) await sleep(50);
  if (pidAlive(info.pid)) {
    try {
      process.kill(info.pid);
    } catch {
      // already gone
    }
  }
  removeRunFiles(name, info.endpoint);
  writeStatus(name, { state: "ended", tool: null });
  return { ok: true };
}
