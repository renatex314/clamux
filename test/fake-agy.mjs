// Stand-in for `agy` in tests: reports lifecycle events through the real clamux hook
// using Antigravity CLI's camelCase payload and JSONL transcript format.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const transcript = path.join(process.env.HOME ?? ".", "fake-agy.jsonl");
if (process.env.FAKE_NO_TRANSCRIPT !== "1") fs.writeFileSync(transcript, "");

const hook = (event, extra = {}) =>
  spawnSync(process.execPath, [process.env.CLAMUX_CLI, "hook", event], {
    input: JSON.stringify({
      conversationId: "agy-conv-1",
      workspacePaths: [process.cwd()],
      transcriptPath: transcript,
      ...extra,
    }),
    env: process.env,
  });

let stepIdx = 0;
const log = (type, content) =>
  fs.appendFileSync(
    transcript,
    JSON.stringify({ step_index: stepIdx++, type, status: "DONE", created_at: new Date().toISOString(), content }) + "\n",
  );
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log(`agy-ready args=${process.argv.slice(2).join(" ")}`);
console.log("? for shortcuts");
let started = false;
for await (const line of readline.createInterface({ input: process.stdin })) {
  if (!started) {
    started = true;
    hook("SessionStart");
  }
  hook("PreInvocation");
  log("USER_INPUT", line);
  await sleep(Number(process.env.FAKE_WORK_MS ?? 1000));
  hook("PostToolUse", { toolCall: { name: "run_command" } });
  console.log("agy-answer: " + line);
  log("PLANNER_RESPONSE", "agy-answer: " + line);
  hook("Stop");
}
