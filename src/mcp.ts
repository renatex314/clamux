import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Clamux, type Session } from "./client.js";
import { ClamuxError } from "./errors.js";

const cx = new Clamux();

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };
const text = (t: string): ToolResult => ({ content: [{ type: "text", text: t }] });
const json = (v: unknown): ToolResult => text(JSON.stringify(v, null, 2));
const fail = (t: string): ToolResult => ({ ...text(t), isError: true });

/** Runs a tool body; clamux failures become tool errors the model can read and react to. */
async function run(body: () => Promise<ToolResult> | ToolResult): Promise<ToolResult> {
  try {
    return await body();
  } catch (e) {
    if (e instanceof ClamuxError) return fail(`${e.code}: ${e.message}`);
    return fail(e instanceof Error ? e.message : String(e));
  }
}

const brief = (s: Session) => ({
  name: s.name, agent: s.agent, state: s.state, detail: s.detail || undefined, for_seconds: Math.round(s.ageS),
  dir: s.cwd, live: s.live, resumable: s.resumable,
});

const name = z.string().describe("Session name, as shown by list_sessions");
const timeout = (def: number) =>
  z.number().int().min(1).max(3600).default(def).describe("How long to wait, in seconds");

/** What a caller needs to know when a session did not finish: its state, and the screen if it wants input. */
async function stalled(session: Session): Promise<ToolResult> {
  const screen = await cx.screen(session.name).catch(() => "");
  const hint = session.state === "waiting"
    ? "It is waiting for input (a permission prompt?). Read the screen, then answer with press_keys."
    : session.state === "starting"
      ? "It has not started yet - usually Claude's first-time 'trust this folder' prompt. Read the screen, then press_keys (for example Down, Enter to trust it)."
      : "It is still working. Call wait_for_session to keep waiting, or get_answer when it is idle.";
  return text(`Session '${session.name}' is ${session.state}. ${hint}\n\n--- screen ---\n${screen}`);
}

export async function runMcp(): Promise<void> {
  const version = (createRequire(import.meta.url)("../package.json") as { version: string }).version;
  const server = new McpServer({ name: "clamux", version }, {
    instructions:
      "Drives interactive Claude Code and Antigravity CLI (agy / Gemini) sessions that keep running in the background. Typical flow: create_session (pass agent: 'claude' or 'agy'/'gemini'), " +
      "then ask (send a prompt and get the agent's reply), repeat, and kill_session when done. A session that was " +
      "killed or lost (e.g. after a reboot) can be brought back with resume_session. If a session is 'waiting', " +
      "it needs a keypress: read_screen, then press_keys.",
  });

  server.registerTool("list_sessions", {
    title: "List sessions",
    description: "List all known Claude Code and Antigravity CLI (agy) sessions with their agent ('claude' or 'agy') and state: working, idle, waiting (needs input), starting, ended or dead. 'resumable' sessions are not running but can be restarted with resume_session.",
    annotations: { readOnlyHint: true },
  }, () => run(() => json(cx.list().map(brief))));

  server.registerTool("create_session", {
    title: "Create session",
    description: "Start a new Claude Code or Antigravity CLI (agy) session in a directory. It runs in the background until killed. Returns once the agent has started; if it is stuck on a startup/trust prompt, the result says so and includes the screen.",
    inputSchema: {
      name: z.string().describe("Letters, digits, - and _ only (max 32 characters)"),
      dir: z.string().optional().describe("Working directory (default: the directory clamux was started in)"),
      agent: z.enum(["claude", "agy", "gemini"]).optional().describe("Agent CLI to run: 'claude' (default) or 'agy' ('gemini' is an alias for 'agy')"),
      session_id: z.string().optional().describe("Continue an existing conversation: a Claude Code session UUID, or an agy conversation id. The directory defaults to the one that conversation ran in"),
      claude_args: z.array(z.string()).optional().describe('Extra arguments for the agent CLI, e.g. ["--model", "opus"]'),
      notify: z.boolean().optional().describe("Desktop notification when the session finishes or needs input (default false)"),
    },
  }, ({ name: n, dir, agent, session_id, claude_args, notify }) => run(async () => {
    const created = await cx.create(n, { dir, agent, sessionId: session_id, claudeArgs: claude_args, notify });
    const s = await cx.waitFor(n, (x) => x.state !== "starting", { timeoutMs: 20_000 }).catch(() => cx.get(n) ?? created);
    return s.state === "starting" ? stalled(s) : json(brief(s));
  }));

  server.registerTool("ask", {
    title: "Ask a session",
    description: "Send a prompt to a session and wait for the agent (Claude or agy) to finish answering; returns its final reply as text. If it stops for a permission prompt or runs past the timeout, returns the session state and screen instead (use press_keys / wait_for_session). Fails with BUSY if the session is already working.",
    inputSchema: {
      name,
      prompt: z.string().min(1),
      timeout_seconds: timeout(300),
      force: z.boolean().optional().describe("Send even if the session is busy (the text is typed into a working session)"),
    },
  }, ({ name: n, prompt, timeout_seconds, force }) => run(async () => {
    try {
      const r = await cx.ask(n, prompt, { timeoutMs: timeout_seconds * 1000, force });
      return text(r.answer ?? `(the reply could not be read from the transcript; this is the screen)\n\n${r.screen}`);
    } catch (e) {
      if (e instanceof ClamuxError && e.code === "TIMEOUT") return stalled(cx.get(n) as Session);
      throw e;
    }
  }));

  server.registerTool("send_prompt", {
    title: "Send a prompt",
    description: "Type a prompt into a session and return immediately, without waiting for the answer. Use wait_for_session and get_answer afterwards, or use ask to do all three. Fails with BUSY if the session is working or waiting.",
    inputSchema: { name, prompt: z.string().min(1), force: z.boolean().optional() },
  }, ({ name: n, prompt, force }) => run(async () => {
    await cx.send(n, prompt, { force });
    return text(`Sent to '${n}'.`);
  }));

  server.registerTool("wait_for_session", {
    title: "Wait for a session",
    description: "Wait until a session stops working. Returns the agent's latest reply if it is idle, or the screen if it needs input.",
    inputSchema: { name, timeout_seconds: timeout(300) },
    annotations: { readOnlyHint: true },
  }, ({ name: n, timeout_seconds }) => run(async () => {
    try {
      const s = await cx.waitFor(n, (x) => x.state !== "working" && x.state !== "starting", { timeoutMs: timeout_seconds * 1000 });
      return s.state === "idle" ? text(cx.lastAnswer(n) ?? "(idle; no reply yet)") : stalled(s);
    } catch (e) {
      if (e instanceof ClamuxError && e.code === "TIMEOUT") return stalled(cx.get(n) as Session);
      throw e;
    }
  }));

  server.registerTool("get_answer", {
    title: "Get the latest answer",
    description: "The agent's most recent reply in a session, as plain text, without sending anything.",
    inputSchema: { name },
    annotations: { readOnlyHint: true },
  }, ({ name: n }) => run(() => text(cx.lastAnswer(n) ?? "(no reply yet)")));

  server.registerTool("read_screen", {
    title: "Read the screen",
    description: "The session's current terminal screen as text. Use it to see what a 'waiting' session is asking before answering with press_keys.",
    inputSchema: { name },
    annotations: { readOnlyHint: true },
  }, ({ name: n }) => run(async () => text(await cx.screen(n))));

  server.registerTool("press_keys", {
    title: "Press keys",
    description: "Send keystrokes to a session, in order. Named keys: Enter, Escape, Tab, Space, BSpace, Up, Down, Left, Right, Home, End, PageUp, PageDown, Delete, and C-x for Ctrl-x (e.g. C-c). Any other string is typed literally. Example: answer a permission prompt with [\"Down\", \"Enter\"] or [\"y\"].",
    inputSchema: { name, keys: z.array(z.string()).min(1) },
  }, ({ name: n, keys }) => run(async () => {
    await cx.press(n, ...keys);
    return text(`Pressed ${keys.join(" ")} in '${n}'.`);
  }));

  server.registerTool("resume_session", {
    title: "Resume a session",
    description: "Restart a saved session that is not running (killed, or lost to a reboot or crash) and continue its Claude or agy conversation where it left off. If it never had a conversation it starts fresh.",
    inputSchema: { name },
  }, ({ name: n }) => run(async () => {
    const r = await cx.resume(n);
    return text(`Resumed '${n}'${r.resumed ? "" : " (fresh: no conversation had been recorded)"}.`);
  }));

  server.registerTool("kill_session", {
    title: "Kill a session",
    description: "Stop a running session. It stays saved, so resume_session can bring it back; use forget_session to delete it for good.",
    inputSchema: { name },
    annotations: { destructiveHint: true },
  }, ({ name: n }) => run(async () => {
    await cx.kill(n);
    return text(`Killed '${n}'. It can be resumed.`);
  }));

  server.registerTool("forget_session", {
    title: "Forget a session",
    description: "Delete a stopped session and its saved record permanently (its conversation can no longer be resumed through clamux). Fails with BUSY if it is running - kill it first.",
    inputSchema: { name },
    annotations: { destructiveHint: true },
  }, ({ name: n }) => run(() => {
    cx.forget(n);
    return text(`Forgot '${n}'.`);
  }));

  await server.connect(new StdioServerTransport());
}
