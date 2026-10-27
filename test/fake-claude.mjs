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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

hook("SessionStart");
console.log(`ready args=${process.argv.slice(2).join(" ")}`);
for await (const line of readline.createInterface({ input: process.stdin })) {
  hook("UserPromptSubmit");
  hook("PreToolUse");
  await sleep(Number(process.env.FAKE_WORK_MS ?? 1000));
  console.log("answer: " + line);
  hook("PostToolUse");
  hook("Stop");
}
hook("SessionEnd");
