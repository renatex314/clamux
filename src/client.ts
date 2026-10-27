import { ClamuxError } from "./errors.js";
import { readStatus, snapshot, type DisplayState, type Row } from "./status.js";
import { attachSession } from "./attach.js";
import { lastAnswer } from "./transcript.js";
import {
  capturePane, cleanStale, createSession, fetchScreen, forgetSession, killSession, liveSessions, pressKeys,
  resumeSession, sendPrompt, type Result,
} from "./sessions.js";

/** A snapshot of one session. */
export type Session = Row;
export type SessionState = DisplayState;

export interface CreateOptions {
  /** Directory Claude Code starts in. Default: the current working directory. */
  dir?: string;
  /** macOS notification when the session goes idle or needs you. Default: false (the CLI/TUI default to true). */
  notify?: boolean;
  /** Extra arguments passed to `claude`, e.g. ["--model", "opus"]. */
  claudeArgs?: string[];
}

export interface WaitOptions {
  /** Reject with code TIMEOUT after this long. Default: no timeout. */
  timeoutMs?: number;
  /** How often to poll. Default: 500. */
  pollMs?: number;
  signal?: AbortSignal;
}

export interface SendOptions {
  /** Send even if the session is working or waiting (the text is typed into a busy TUI). */
  force?: boolean;
}

export interface AskResult {
  session: Session;
  /** Claude's final reply to this prompt as plain text, read from the transcript. Null if it could not be read. */
  answer: string | null;
  /** The visible screen after Claude finished (the whole interface, not just the reply). */
  screen: string;
  /** Claude Code's transcript file for this session, if the hooks have reported it. */
  transcriptPath: string | null;
}

export interface StateChange {
  name: string;
  from: SessionState | undefined;
  to: SessionState;
  session: Session;
}

function unwrap(r: Result): void {
  if (!r.ok) throw new ClamuxError(r.code, r.error);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done);
  });
}

/**
 * Programmatic access to clamux sessions. Methods that read state (`list`, `get`, `peek`) are
 * synchronous; everything that talks to a session or waits is async. Failures throw
 * {@link ClamuxError} with a `code`.
 */
export class Clamux {
  /** All known sessions, live or not (ended/dead ones stay until `clean()`). */
  list(): Session[] {
    return snapshot(liveSessions());
  }

  get(name: string): Session | undefined {
    return this.list().find((s) => s.name === name);
  }

  /** Starts Claude Code in a new detached session. */
  async create(name: string, opts: CreateOptions = {}): Promise<Session> {
    unwrap(await createSession(name, opts.dir ?? ".", { notify: opts.notify ?? false, claudeArgs: opts.claudeArgs }));
    return this.require(name);
  }

  /** Types a prompt into the session. Throws BUSY if it is working/waiting, unless `force`. */
  async send(name: string, prompt: string, opts: SendOptions = {}): Promise<void> {
    const s = this.require(name);
    if ((s.state === "working" || s.state === "waiting") && !opts.force) {
      throw new ClamuxError("BUSY", `'${name}' is ${s.state}; pass { force: true } to send anyway`);
    }
    unwrap(await sendPrompt(name, prompt));
  }

  /** Sends key names ("Enter", "Down", "Escape", "C-c") or literal text, e.g. to answer a permission prompt. */
  async press(name: string, ...keys: string[]): Promise<void> {
    unwrap(await pressKeys(name, keys));
  }

  /** The session's exact screen right now, asked of the session host. Prefer this over `peek` when you need it current. */
  async screen(name: string): Promise<string> {
    this.require(name);
    const r = await fetchScreen(name);
    if (!r.ok) throw new ClamuxError(r.code, r.error);
    return r.text.trimEnd();
  }

  /** The visible contents of the session's screen, read from a file the host refreshes ~8x/second (may trail slightly). */
  peek(name: string): string {
    this.require(name);
    return capturePane(name).trimEnd();
  }

  /**
   * Resolves once `predicate` holds for the session. The session must stay alive; if it dies while
   * waiting this rejects with NOT_FOUND.
   */
  async waitFor(name: string, predicate: (s: Session) => boolean, opts: WaitOptions = {}): Promise<Session> {
    const { timeoutMs, pollMs = 500, signal } = opts;
    const deadline = timeoutMs === undefined ? Infinity : Date.now() + timeoutMs;
    let last: Session | undefined;
    for (;;) {
      if (signal?.aborted) throw new ClamuxError("ABORTED", "aborted");
      last = this.get(name);
      if (!last || !last.live) throw new ClamuxError("NOT_FOUND", `session '${name}' is not running`);
      if (predicate(last)) return last;
      if (Date.now() >= deadline) {
        throw new ClamuxError("TIMEOUT", `timed out waiting for '${name}' (last state: ${last.state})`);
      }
      await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())), signal);
    }
  }

  /** Resolves when the session is idle. */
  waitForIdle(name: string, opts: WaitOptions = {}): Promise<Session> {
    return this.waitFor(name, (s) => s.state === "idle", opts);
  }

  /**
   * Sends a prompt and waits for Claude to finish answering it (the session goes working -> idle
   * after the prompt was sent). If Claude stops to ask for permission the session sits in `waiting`
   * and this will time out - handle that with `watch()`/`press()` or a `timeoutMs`.
   */
  async ask(name: string, prompt: string, opts: SendOptions & WaitOptions = {}): Promise<AskResult> {
    const sentAt = Date.now() / 1000;
    await this.send(name, prompt, opts);
    // "idle" is only meaningful if the session entered it after we sent the prompt.
    const session = await this.waitFor(
      name,
      (s) => s.state === "idle" && (readStatus(name)?.since ?? 0) >= sentAt,
      opts,
    );
    const screen = await this.screen(name);
    // The hook that reports "idle" can fire a moment before Claude's last transcript line is flushed.
    let answer: string | null = null;
    for (let i = 0; i < 20 && answer === null && session.transcriptPath; i++) {
      answer = lastAnswer(session.transcriptPath, sentAt * 1000 - 1000);
      if (answer === null) await sleep(100);
    }
    return { session, answer, screen, transcriptPath: session.transcriptPath };
  }

  /**
   * Claude's most recent reply in this session, read from its transcript (null if it has not answered yet).
   * Unlike `screen`, this is the reply text alone, without the interface around it.
   */
  lastAnswer(name: string): string | null {
    const path = this.require(name).transcriptPath;
    return path ? lastAnswer(path) : null;
  }

  /** Yields every state change (including sessions appearing) until `signal` aborts. */
  async *watch(opts: { pollMs?: number; signal?: AbortSignal } = {}): AsyncGenerator<StateChange> {
    const { pollMs = 500, signal } = opts;
    let prev = new Map(this.list().map((s) => [s.name, s.state] as const));
    while (!signal?.aborted) {
      await sleep(pollMs, signal);
      if (signal?.aborted) return;
      const now = this.list();
      for (const s of now) {
        if (prev.get(s.name) !== s.state) yield { name: s.name, from: prev.get(s.name), to: s.state, session: s };
      }
      prev = new Map(now.map((s) => [s.name, s.state] as const));
    }
  }

  /** Connects the current terminal to the session; resolves when the user detaches (Ctrl-b d). */
  async attach(name: string): Promise<void> {
    unwrap(await attachSession(name));
  }

  /** Stops the session. It stays saved (`resumable`), so `resume` can bring it back. */
  async kill(name: string): Promise<void> {
    unwrap(await killSession(name));
  }

  /**
   * Restarts a saved session that is not running (killed, or lost to a reboot or crash) and continues its
   * Claude conversation. `resumed` is false when no conversation had been recorded and it started fresh.
   */
  async resume(name: string): Promise<{ session: Session; resumed: boolean }> {
    const r = await resumeSession(name);
    if (!r.ok) throw new ClamuxError(r.code, r.error);
    return { session: this.require(name), resumed: r.resumed };
  }

  /** Deletes a session that is not running, along with its saved record. Throws BUSY if it is running. */
  forget(name: string): void {
    unwrap(forgetSession(name));
  }

  /** Removes status entries of sessions that are neither running nor saved. Returns their names. */
  clean(): string[] {
    return cleanStale();
  }

  private require(name: string): Session {
    const s = this.get(name);
    if (!s || !s.live) throw new ClamuxError("NOT_FOUND", `no live session '${name}'`);
    return s;
  }
}
