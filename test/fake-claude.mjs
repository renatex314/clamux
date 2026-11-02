// Stand-in for `claude` in tests: reports lifecycle events through the real clamux hook,
// the way Claude Code would, so the SDK can be tested without a model or a subscription.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

// Like Claude, the transcript exists once a conversation does (FAKE_NO_TRANSCRIPT=1 simulates one that never started).
const transcript = path.join(process.env.HOME ?? ".", "fake.jsonl");
if (process.env.FAKE_NO_TRANSCRIPT !== "1") fs.writeFileSync(transcript, "");

const hook = (event) =>
  spawnSync(process.execPath, [process.env.CLAMUX_CLI, "hook"], {
    input: JSON.stringify({
      hook_event_name: event, session_id: "fake-1", cwd: process.cwd(),
      tool_name: "Bash", transcript_path: transcript,
    }),
    env: process.env,
  });
const log = (type, content) =>
  fs.appendFileSync(transcript, JSON.stringify({ type, timestamp: new Date().toISOString(), message: { role: type, content } }) + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Drawn before SessionStart reports idle, so a test that waits for idle always finds the screen.
console.log(`ready args=${process.argv.slice(2).join(" ")}`);
console.log(`config=${process.env.CLAUDE_CONFIG_DIR ?? "-"}`);
hook("SessionStart");
// FAKE_BRACKETED=1: like Claude Code, ask for bracketed paste and take a prompt as pasted text + Enter
// (a newline inside a paste is part of the prompt; Enter outside one submits it).
async function* bracketedPrompts() {
  process.stdin.setRawMode?.(true);
  process.stdout.write("\x1b[?2004h");
  let buf = "", text = "", pasting = false;
  for await (const chunk of process.stdin) {
    buf += chunk.toString("utf8");
    for (;;) {
      if (pasting) {
        const end = buf.indexOf("\x1b[201~");
        if (end < 0) { text += buf; buf = ""; break; }
        text += buf.slice(0, end); buf = buf.slice(end + 6); pasting = false;
        process.stdout.write(`[pasted ${text.length} chars]`);
      } else if (buf.startsWith("\x1b[200~")) {
        buf = buf.slice(6); pasting = true;
      } else if (buf.startsWith("\r")) {
        buf = buf.slice(1);
        process.stdout.write("\r\n");
        yield text.replace(/\r/g, "\n");
        text = "";
      } else if (buf) {
        const next = buf.search(/\x1b\[200~|\r/);
        const typed = next < 0 ? buf : buf.slice(0, next);
        text += typed; buf = buf.slice(typed.length);
        process.stdout.write(typed);
        if (next < 0) break;
      } else break;
    }
  }
}

const prompts = process.env.FAKE_BRACKETED === "1" ? bracketedPrompts() : readline.createInterface({ input: process.stdin });
for await (const line of prompts) {
  hook("UserPromptSubmit");
  log("user", line);
  hook("PreToolUse");
  log("assistant", [{ type: "text", text: "thinking out loud" }, { type: "tool_use", name: "Bash" }]);
  log("user", [{ type: "tool_result", content: "ok" }]);
  await sleep(Number(process.env.FAKE_WORK_MS ?? 1000));
  console.log("answer: " + line);
  log("assistant", [{ type: "thinking", thinking: "" }]);
  log("assistant", [{ type: "text", text: "answer: " + line }]);
  hook("PostToolUse");
  hook("Stop");
}
hook("SessionEnd");
