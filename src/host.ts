import fs from "node:fs";
import net from "node:net";
import { createRequire } from "node:module";
import path from "node:path";
import { childEnv } from "./env.js";
import { RUN_DIR, configFile, endpointFor, errorFile, idFile, registryFile, screenFile } from "./paths.js";
import { readMessages, send, type Msg } from "./ipc.js";
import { removeRunFiles, writeRegistry } from "./registry.js";
import type { Agent } from "./saved.js";
import { notify } from "./notify.js";
import { readStatus, writeStatus } from "./status.js";

export interface HostConfig {
  cwd: string;
  agent?: Agent;
  claudeArgs: string[];
  cols: number;
  rows: number;
}

/** node-pty ships its spawn-helper without the execute bit on some installs, which breaks every spawn. */
function ensureSpawnHelper(): void {
  if (process.platform === "win32") return;
  try {
    const entry = createRequire(import.meta.url).resolve("node-pty");
    const root = path.resolve(path.dirname(entry), "..");
    const candidates = [path.join(root, "build", "Release"), path.join(root, "build", "Debug")];
    const prebuilds = path.join(root, "prebuilds");
    if (fs.existsSync(prebuilds)) for (const d of fs.readdirSync(prebuilds)) candidates.push(path.join(prebuilds, d));
    for (const dir of candidates) {
      const helper = path.join(dir, "spawn-helper");
      if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755);
    }
  } catch {
    // if this fails the spawn below reports the real error
  }
}

/** On Windows the executable may be claude.exe or an npm-style claude.cmd shim, which a pty cannot run directly. */
function resolveCommand(cmd: string, args: string[]): { file: string; args: string[] } {
  if (process.platform !== "win32") return { file: cmd, args };
  const exts = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";");
  const dirs = (process.env.PATH ?? process.env.Path ?? "").split(";").filter(Boolean);
  for (const dir of dirs) {
    for (const ext of ["", ...exts]) {
      const candidate = path.join(dir, cmd + ext);
      if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) continue;
      if (/\.(cmd|bat)$/i.test(candidate)) {
        return { file: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", candidate, ...args] };
      }
      return { file: candidate, args };
    }
  }
  return { file: cmd, args };
}

const SCREEN_WRITE_MS = 120;
/** A prompt is pasted in pieces this long (in characters), a moment apart, so no input buffer overflows. */
const PASTE_CHUNK = 1024;
/** After pasting, Enter waits until the app has drawn nothing for this long (it may still be ingesting the text)... */
const PASTE_SETTLE_MS = 250;
/** ...but no longer than this. */
const PASTE_MAX_WAIT_MS = 10_000;
/** How often the host checks the status the hooks write, to notify on changes. */
const NOTIFY_POLL_MS = 300;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const MOUSE_MODES: Record<string, string> = { x10: "9", vt200: "1000", drag: "1002", any: "1003" };

/** The serialized screen holds contents only; this re-enables the input modes the app had switched on. */
function modeSequences(m: { bracketedPasteMode: boolean; applicationCursorKeysMode: boolean; mouseTrackingMode: string }): string {
  let out = "";
  if (m.bracketedPasteMode) out += "\x1b[?2004h";
  if (m.applicationCursorKeysMode) out += "\x1b[?1h";
  const mouse = MOUSE_MODES[m.mouseTrackingMode];
  if (mouse) out += `\x1b[?${mouse}h\x1b[?1006h`;
  return out;
}

/** Runs one session: owns the Claude Code pty and a virtual screen, and serves clients on a socket. */
export async function runHost(name: string, cfg: HostConfig, settingsPath: string): Promise<void> {
  // Fixed for the life of the host; the session's current name is kept under it (see identity.ts), so the agent's
  // hooks and tools still find the session after a rename.
  const hostId = process.env.CLAMUX_ID ?? null;
  const writeId = () => {
    if (!hostId) return;
    fs.mkdirSync(path.dirname(idFile(hostId)), { recursive: true });
    fs.writeFileSync(idFile(hostId), name);
  };
  ensureSpawnHelper();
  const pty = await import("node-pty");
  const { Terminal } = (await import("@xterm/headless")).default;
  const { SerializeAddon } = (await import("@xterm/addon-serialize")).default;

  const term = new Terminal({ cols: cfg.cols, rows: cfg.rows, scrollback: 2000, allowProposedApi: true });
  const serializer = new SerializeAddon();
  term.loadAddon(serializer);

  const isAgy = cfg.agent === "agy";
  const agyArgs = cfg.claudeArgs.includes("--dangerously-skip-permissions")
    ? cfg.claudeArgs
    : ["--dangerously-skip-permissions", ...cfg.claudeArgs];
  const { file, args } = isAgy
    ? resolveCommand("agy", agyArgs)
    : resolveCommand("claude", ["--settings", settingsPath, ...cfg.claudeArgs]);
  const ptyOpts = {
    name: "xterm-256color",
    cols: cfg.cols,
    rows: cfg.rows,
    cwd: cfg.cwd,
    env: childEnv({ TERM: "xterm-256color", COLORTERM: "truecolor" }),
  };
  // On Windows, use the ConPTY that ships with node-pty (Windows Terminal's) rather than the one built into
  // Windows: the built-in one mangles some redraws (e.g. scrolling inside Claude Code leaves stray characters).
  // CLAMUX_CONPTY_DLL=0 goes back to the built-in one.
  const bundledConpty = process.platform === "win32" && process.env.CLAMUX_CONPTY_DLL !== "0";
  let proc: ReturnType<typeof pty.spawn>;
  try {
    proc = pty.spawn(file, args, bundledConpty ? { ...ptyOpts, useConptyDll: true } : ptyOpts);
  } catch (e) {
    if (!bundledConpty) throw e;
    proc = pty.spawn(file, args, ptyOpts);
  }

  const attached = new Set<net.Socket>();
  let exited = false;
  let lastOutputAt = 0;

  const screenText = () => {
    const b = term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < term.rows; i++) lines.push(b.getLine(b.viewportY + i)?.translateToString(true) ?? "");
    return lines.join("\n");
  };

  // Plain-text copy of the visible screen, so previews and `peek` can read it synchronously.
  let agyMarkedIdle = false;
  const writeScreen = () => {
    const text = screenText();
    // Antigravity CLI (`agy`) fires SessionStart on the first prompt rather than TUI launch;
    // once its prompt bar (`? for shortcuts`) is drawn, the session is ready and idle.
    if (isAgy && !agyMarkedIdle && text.includes("? for shortcuts")) {
      agyMarkedIdle = true;
      if (readStatus(name)?.state === "starting") writeStatus(name, { state: "idle", tool: null });
    }
    try {
      const tmp = `${screenFile(name)}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, text);
      fs.renameSync(tmp, screenFile(name));
    } catch {
      // a reader may hold the file open on Windows; the next tick retries
    }
  };
  let screenTimer: NodeJS.Timeout | undefined;
  const scheduleScreen = () => {
    screenTimer ??= setTimeout(() => {
      screenTimer = undefined;
      term.write("", writeScreen);
    }, SCREEN_WRITE_MS);
  };

  proc.onData((d) => {
    lastOutputAt = Date.now();
    // Broadcast only after the emulator has parsed the data, so a client that joins in the
    // middle (snapshot taken in a write callback) neither misses nor duplicates output.
    term.write(d, () => {
      for (const c of attached) send(c, { t: "out", d });
    });
    scheduleScreen();
  });
  // Answers the emulator generates to terminal queries (cursor position, device attributes...).
  // With a real terminal attached, that terminal answers instead - never both.
  term.onData((reply) => {
    if (attached.size === 0 && !exited) proc.write(reply);
  });

  const resize = (cols: number, rows: number) => {
    if (exited || cols < 2 || rows < 2) return;
    try {
      proc.resize(cols, rows);
      term.resize(cols, rows);
    } catch {
      // process already gone
    }
  };

  /**
   * Types a prompt and submits it. The text goes in as a bracketed paste when the app asked for those (Claude
   * Code and agy do): typed as plain keys, its newlines and some characters (`#`, `!`, `/` at the start, Esc...)
   * act as shortcuts, and a long prompt reaches the app in bursts it can mistake for several inputs. Enter is
   * only pressed once the app has drawn the text, and not at all if the screen never changed.
   */
  const typePrompt = async (text: string): Promise<{ ok: true } | { ok: false; error: string }> => {
    const flushed = () => new Promise<void>((r) => term.write("", r));
    await flushed();
    const before = screenText();
    const startedAt = Date.now();
    const bracketed = term.modes.bracketedPasteMode;
    const body = bracketed ? text.replace(/\r?\n/g, "\r") : text;
    if (bracketed) proc.write("\x1b[200~");
    let chunk = "";
    for (const ch of body) { // by code point, so no character is split between writes
      chunk += ch;
      if (chunk.length >= PASTE_CHUNK) {
        proc.write(chunk);
        chunk = "";
        await sleep(10);
      }
    }
    if (chunk) proc.write(chunk);
    if (bracketed) proc.write("\x1b[201~");
    // Wait for the text to show up and the screen to settle. A busy app (Claude Code just after starting)
    // can take well over the settle time to echo anything, so quiet alone does not mean it is done.
    for (;;) {
      await sleep(50);
      if (exited) return { ok: false, error: "the session ended while the prompt was being typed" };
      const quiet = Date.now() - Math.max(lastOutputAt, startedAt) >= PASTE_SETTLE_MS;
      const shown = !text.trim() || screenText() !== before;
      if ((quiet && shown) || Date.now() - startedAt >= PASTE_MAX_WAIT_MS) break;
    }
    await flushed();
    if (text.trim() && screenText() === before) {
      return { ok: false, error: "the prompt did not show up in the session, so it was not submitted" };
    }
    proc.write("\r");
    return { ok: true };
  };

  let typing = Promise.resolve();

  const server = net.createServer((sock) => {
    readMessages(sock, (m: Msg) => {
      switch (m.t) {
        case "input":
          if (!exited) proc.write(String(m.d ?? ""));
          break;
        case "paste": // as the terminal would paste it: bracketed if the app asked for that
          if (!exited) {
            const text = String(m.d ?? "");
            proc.write(term.modes.bracketedPasteMode ? `\x1b[200~${text.replace(/\r?\n/g, "\r")}\x1b[201~` : text);
          }
          break;
        case "prompt": { // one at a time, so two prompts never interleave
          const text = String(m.d ?? "");
          typing = typing.then(async () => {
            const r = exited ? { ok: false, error: "the session has ended" } : await typePrompt(text);
            send(sock, { t: "prompted", ...r });
          });
          break;
        }
        case "attach":
          resize(Number(m.cols) || cfg.cols, Number(m.rows) || cfg.rows);
          term.write("", () => {
            send(sock, { t: "snapshot", d: "\x1b[2J\x1b[H" + serializer.serialize() + modeSequences(term.modes) });
            attached.add(sock);
          });
          break;
        case "resize":
          resize(Number(m.cols), Number(m.rows));
          break;
        case "detach":
          attached.delete(sock);
          if (attached.size === 0) resize(cfg.cols, cfg.rows);
          break;
        case "screen": // exact, unlike the file, which trails by up to SCREEN_WRITE_MS
          term.write("", () => send(sock, { t: "screen", d: screenText() }));
          break;
        case "kill":
          if (!exited) proc.kill();
          break;
        case "ping":
          send(sock, { t: "pong", prompt: true, paste: true, rename: Boolean(hostId) }); // what this host understands
          break;
        case "rename": { // the caller has checked the new name is free; the status and saved records are its job
          const to = String(m.to ?? "");
          try {
            for (const f of [registryFile, configFile, screenFile, errorFile]) {
              try {
                fs.renameSync(f(name), f(to));
              } catch (e) {
                if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
              }
            }
            name = to;
            writeId();
            send(sock, { t: "renamed", ok: true });
          } catch (e) {
            send(sock, { t: "renamed", ok: false, error: e instanceof Error ? e.message : String(e) });
          }
          break;
        }
      }
    });
    sock.on("error", () => {});
    sock.on("close", () => {
      if (attached.delete(sock) && attached.size === 0) resize(cfg.cols, cfg.rows);
    });
  });

  const endpoint = endpointFor(hostId ? `id-${hostId}` : name);
  if (process.platform !== "win32") fs.rmSync(endpoint, { force: true }); // stale socket from a crash
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, resolve);
  });
  if (process.platform !== "win32") fs.chmodSync(endpoint, 0o600);

  const shutdown = (code: number) => {
    for (const c of attached) send(c, { t: "exit", code });
    if (screenTimer) clearTimeout(screenTimer);
    server.close();
    removeRunFiles(name, endpoint);
    if (hostId) fs.rmSync(idFile(hostId), { force: true });
    setTimeout(() => process.exit(0), 150); // let the exit frames flush
  };

  proc.onExit(({ exitCode }) => {
    exited = true;
    shutdown(exitCode);
  });
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    process.on(sig, () => {
      if (!exited) proc.kill();
      else shutdown(0);
    });
  }

  // Desktop notifications on the status changes the hooks record.
  if (process.env.CLAMUX_NOTIFY === "1") {
    let last = readStatus(name)?.state;
    setInterval(() => {
      const st = readStatus(name);
      if (!st || st.state === last) return;
      const prev = last;
      last = st.state;
      if (st.state === "idle" && prev === "working") notify(`clamux: ${name}`, "Finished - waiting for your next prompt");
      else if (st.state === "waiting") notify(`clamux: ${name}`, st.message || "Needs your attention");
    }, NOTIFY_POLL_MS).unref();
  }

  writeId();
  writeScreen();
  writeRegistry(name, { pid: process.pid, endpoint, cwd: cfg.cwd, startedAt: Date.now() / 1000 });
}

/** Entry point of `clamux host <name>`: any failure is written where `createSession` will find it. */
export async function hostMain(name: string, cfg: HostConfig, settingsPath: string): Promise<void> {
  try {
    await runHost(name, cfg, settingsPath);
  } catch (e) {
    fs.mkdirSync(RUN_DIR, { recursive: true });
    fs.writeFileSync(errorFile(name), e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
