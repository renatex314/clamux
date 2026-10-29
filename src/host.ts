import fs from "node:fs";
import net from "node:net";
import { createRequire } from "node:module";
import path from "node:path";
import { childEnv } from "./env.js";
import { RUN_DIR, endpointFor, errorFile, screenFile } from "./paths.js";
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
/** How often the host checks the status the hooks write, to notify on changes. */
const NOTIFY_POLL_MS = 300;

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

  const server = net.createServer((sock) => {
    readMessages(sock, (m: Msg) => {
      switch (m.t) {
        case "input":
          if (!exited) proc.write(String(m.d ?? ""));
          break;
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
          send(sock, { t: "pong" });
          break;
      }
    });
    sock.on("error", () => {});
    sock.on("close", () => {
      if (attached.delete(sock) && attached.size === 0) resize(cfg.cols, cfg.rows);
    });
  });

  const endpoint = endpointFor(name);
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
