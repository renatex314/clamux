import fs from "node:fs";
import { updateSaved } from "./saved.js";
import { readStatus, writeStatus, type HookState, type Status } from "./status.js";

interface Payload {
  // Claude Code fields (snake_case)
  hook_event_name?: string;
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  message?: string;
  notification_type?: string;
  transcript_path?: string;
  // Antigravity CLI (agy) fields (camelCase)
  conversationId?: string;
  workspacePaths?: string[];
  transcriptPath?: string;
  toolCall?: { name?: string };
}

/** Entry point Claude Code or Antigravity CLI invokes on each event. Must never fail or block the session. */
export function runHook(eventArg?: string): void {
  const isAgy = Boolean(eventArg);
  try {
    const name = process.env.CLAMUX_NAME;
    if (!name) {
      if (isAgy) process.stdout.write("{}\n");
      return;
    }
    const p = JSON.parse(fs.readFileSync(0, "utf8")) as Payload;
    const event = p.hook_event_name ?? eventArg;
    const sessionId = p.session_id ?? p.conversationId ?? null;
    const cwd = p.cwd ?? p.workspacePaths?.[0] ?? null;
    const transcriptPath = p.transcript_path ?? p.transcriptPath ?? null;
    const toolName = p.tool_name ?? p.toolCall?.name ?? null;
    const cur = readStatus(name);
    let fields: { state: HookState } & Partial<Status>;

    switch (event) {
      // In agy, SessionStart fires when the first prompt creates the conversation (right before PreInvocation).
      case "SessionStart": fields = { state: isAgy ? "working" : "idle", tool: null }; break;
      case "UserPromptSubmit":
      case "PreInvocation": fields = { state: "working", tool: null }; break;
      case "PreToolUse": fields = { state: "working", tool: toolName }; break;
      case "PostToolUse": fields = { state: "working", tool: isAgy ? toolName : null }; break;
      case "Notification":
        // Claude also pings after sitting idle; that is not "needs attention".
        if (cur?.state === "idle" || p.notification_type === "idle_prompt") return;
        fields = { state: "waiting", tool: null, message: p.message ?? null };
        break;
      case "Stop": fields = { state: "idle", tool: null }; break;
      case "SessionEnd": fields = { state: "ended", tool: null }; break;
      default:
        if (isAgy || p.conversationId) process.stdout.write("{}\n");
        return;
    }

    writeStatus(name, {
      session_id: sessionId, cwd, transcript_path: transcriptPath, ...fields,
    });
    // Keep the saved record pointing at the conversation the CLI currently holds (it changes on /clear).
    if (sessionId) updateSaved(name, { sessionId, transcriptPath });
    // Notifications are sent by the session host, which sees this status change: a hook process is gone
    // within milliseconds, before a slow notifier (PowerShell on Windows) has shown anything.
  } catch {
    // swallow: a status hook must never disturb the session
  }
  if (isAgy) process.stdout.write("{}\n");
}
