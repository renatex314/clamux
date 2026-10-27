import fs from "node:fs";
import { notify } from "./notify.js";
import { updateSaved } from "./saved.js";
import { readStatus, writeStatus, type HookState, type Status } from "./status.js";

interface Payload {
  hook_event_name?: string;
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  message?: string;
  notification_type?: string;
  transcript_path?: string;
}

/** Entry point Claude Code invokes on each event. Must never fail or block the session. */
export function runHook(): void {
  try {
    const name = process.env.CLAMUX_NAME;
    if (!name) return;
    const p = JSON.parse(fs.readFileSync(0, "utf8")) as Payload;
    const cur = readStatus(name);
    let fields: { state: HookState } & Partial<Status>;

    switch (p.hook_event_name) {
      case "SessionStart": fields = { state: "idle", tool: null }; break;
      case "UserPromptSubmit": fields = { state: "working", tool: null }; break;
      case "PreToolUse": fields = { state: "working", tool: p.tool_name ?? null }; break;
      case "PostToolUse": fields = { state: "working", tool: null }; break;
      case "Notification":
        // Claude also pings after sitting idle; that is not "needs attention".
        if (cur?.state === "idle" || p.notification_type === "idle_prompt") return;
        fields = { state: "waiting", tool: null, message: p.message ?? null };
        break;
      case "Stop": fields = { state: "idle", tool: null }; break;
      case "SessionEnd": fields = { state: "ended", tool: null }; break;
      default: return;
    }

    const prev = writeStatus(name, {
      session_id: p.session_id ?? null, cwd: p.cwd ?? null, transcript_path: p.transcript_path ?? null, ...fields,
    });
    // Keep the saved record pointing at the conversation Claude currently holds (it changes on /clear).
    if (p.session_id) updateSaved(name, { sessionId: p.session_id, transcriptPath: p.transcript_path ?? null });
    if (process.env.CLAMUX_NOTIFY === "1" && fields.state !== prev) {
      if (fields.state === "idle" && prev === "working") notify(`clamux: ${name}`, "Finished - waiting for your next prompt");
      else if (fields.state === "waiting") notify(`clamux: ${name}`, fields.message || "Needs your attention");
    }
  } catch {
    // swallow: a status hook must never disturb the session
  }
}
