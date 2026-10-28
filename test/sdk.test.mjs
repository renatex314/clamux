import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import * as pty from "node-pty";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Short path: unix socket paths are limited to ~100 chars.
const tmp = fs.mkdtempSync(process.platform === "win32" ? path.join(process.env.TEMP, "clx-") : "/tmp/clx-");
const bin = path.join(tmp, "bin");
fs.mkdirSync(bin);

// A `claude` and `agy` shim on PATH that run the fakes. (Windows runs .cmd shims, everything else a shell script.)
const fake = path.join(root, "test/fake-claude.mjs");
const fakeAgy = path.join(root, "test/fake-agy.mjs");
if (process.platform === "win32") {
  fs.writeFileSync(path.join(bin, "claude.cmd"), `@"${process.execPath}" "${fake}" %*\r\n`);
  fs.writeFileSync(path.join(bin, "agy.cmd"), `@"${process.execPath}" "${fakeAgy}" %*\r\n`);
} else {
  fs.writeFileSync(path.join(bin, "claude"), `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "agy"), `#!/bin/sh\nexec "${process.execPath}" "${fakeAgy}" "$@"\n`, { mode: 0o755 });
}

// Isolate everything the SDK touches: the data dir (HOME) and `claude`.
process.env.HOME = tmp;
process.env.USERPROFILE = tmp;
process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
process.env.CLAMUX_CLI = path.join(root, "dist/cli.js");
process.env.FAKE_WORK_MS = "1000";

const { Clamux, ClamuxError } = await import("../dist/index.js");

const code = async (p) => p.then(() => "no error", (e) => (e instanceof ClamuxError ? e.code : `other: ${e}`));
const throwsCode = (fn) => { try { fn(); return "no error"; } catch (e) { return e instanceof ClamuxError ? e.code : `other: ${e}`; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe("Clamux SDK", () => {
  const cx = new Clamux();

  after(async () => {
    for (const s of cx.list().filter((x) => x.live)) await cx.kill(s.name).catch(() => {});
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("create starts a live session that reports idle", async () => {
    const s = await cx.create("a", { dir: tmp });
    assert.equal(s.name, "a");
    assert.equal(s.live, true);
    assert.equal((await cx.waitForIdle("a", { timeoutMs: 8000 })).state, "idle");
    assert.ok(cx.list().some((x) => x.name === "a"));
    assert.match(await cx.screen("a"), /ready/);
  });

  test("generated hook command runs clamux's own CLI (not the caller's script)", () => {
    const settings = JSON.parse(fs.readFileSync(path.join(tmp, ".clamux/settings.json"), "utf8"));
    const command = settings.hooks.Stop[0].hooks[0].command;
    assert.ok(command.includes(path.join(root, "dist/cli.js").replace(/\\/g, "/")) || command.includes(path.join(root, "dist/cli.js")), command);
    // Run it exactly as Claude Code would: through a shell, payload on stdin, session name in env.
    const run = (event) => execFileSync(process.platform === "win32" ? "cmd.exe" : "sh", process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-c", command], {
      input: JSON.stringify({ hook_event_name: event }),
      env: { ...process.env, CLAMUX_NAME: "a" },
    });
    run("UserPromptSubmit");
    assert.equal(cx.get("a").state, "working");
    run("Stop");
    assert.equal(cx.get("a").state, "idle");
  });

  test("validates names, directories and duplicates", async () => {
    assert.equal(await code(cx.create("bad name!")), "INVALID");
    assert.equal(await code(cx.create("x".repeat(33))), "INVALID");
    assert.equal(await code(cx.create("b", { dir: "/definitely/not/here" })), "INVALID");
    assert.equal(await code(cx.create("a")), "EXISTS");
  });

  test("ask sends a prompt, waits working -> idle, and returns the screen", async () => {
    const events = [];
    const ac = new AbortController();
    const watching = (async () => { for await (const e of cx.watch({ pollMs: 100, signal: ac.signal })) events.push(`${e.from}>${e.to}`); })();

    const r = await cx.ask("a", "hello world", { timeoutMs: 10000 });
    ac.abort();
    await watching;

    assert.equal(r.session.state, "idle");
    assert.match(r.screen, /answer: hello world/); // exact, with no waiting for a file refresh
    assert.equal(r.answer, "answer: hello world"); // the reply alone, from the transcript - not the "thinking out loud" before the tool call
    assert.equal(cx.lastAnswer("a"), "answer: hello world");
    assert.equal(r.transcriptPath, path.join(tmp, "fake.jsonl"));
    assert.ok(events.includes("idle>working"), `saw ${events}`);
    assert.ok(events.includes("working>idle"), `saw ${events}`);
  });

  test("press sends named keys and literal text", async () => {
    await cx.press("a", "typed", "Enter");
    await cx.waitFor("a", (s) => s.state === "working", { timeoutMs: 5000 });
    await cx.waitForIdle("a", { timeoutMs: 8000 });
    assert.match(await cx.screen("a"), /answer: typed/);
    await sleep(300); // and the cheap file-based peek catches up shortly after
    assert.match(cx.peek("a"), /answer: typed/);
  });

  test("send refuses a busy session unless forced; waitFor times out", async () => {
    await cx.send("a", "slow");
    await cx.waitFor("a", (s) => s.state === "working", { timeoutMs: 5000 });
    assert.equal(await code(cx.send("a", "again")), "BUSY");
    assert.equal(await code(cx.waitFor("a", () => false, { timeoutMs: 300, pollMs: 50 })), "TIMEOUT");
    await cx.waitForIdle("a", { timeoutMs: 8000 });
  });

  test("waitFor honours an abort signal", async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    assert.equal(await code(cx.waitFor("a", () => false, { signal: ac.signal, pollMs: 50 })), "ABORTED");
  });

  test("attach shows the screen, forwards typing, and Ctrl-b d detaches without ending the session", async () => {
    const p = pty.spawn(process.execPath, [path.join(root, "dist/cli.js"), "attach", "a"], {
      name: "xterm-256color", cols: 100, rows: 30, cwd: root, env: process.env,
    });
    let out = "";
    let exitCode = null;
    p.onData((d) => (out += d));
    p.onExit((e) => (exitCode = e.exitCode));
    const until = async (re, ms = 5000) => {
      for (let t = 0; t < ms && !re.test(out); t += 50) await sleep(50);
      assert.match(out, re);
    };

    await until(/answer: slow/); // the snapshot replays what was already on screen
    assert.ok(out.includes("\x1b[?1049h"), "enters the alternate screen");
    p.write("live\r");
    await until(/answer: live/); // typed through the client, answered by the session, streamed back
    p.write("\x02d"); // Ctrl-b d
    for (let t = 0; t < 3000 && exitCode === null; t += 50) await sleep(50);
    assert.equal(exitCode, 0);
    assert.ok(out.includes("\x1b[?1049l"), "leaves the alternate screen");
    assert.equal(cx.get("a").live, true);
  });

  test("kill stops the session; operations report NOT_FOUND; the session stays saved and resumable", async () => {
    await cx.kill("a");
    assert.equal(throwsCode(() => cx.peek("a")), "NOT_FOUND");
    assert.equal(await code(cx.kill("a")), "NOT_FOUND");
    assert.equal(await code(cx.send("a", "x")), "NOT_FOUND");
    assert.deepEqual(cx.clean(), []); // saved sessions are not stale
    const s = cx.get("a");
    assert.equal(s.live, false);
    assert.equal(s.resumable, true);
    assert.equal(s.sessionId, "fake-1");
    assert.equal(await code(cx.create("a", { dir: tmp })), "EXISTS"); // would overwrite the saved conversation
  });

  test("resume restarts a killed session with --resume <conversation id>", async () => {
    const r = await cx.resume("a");
    assert.equal(r.resumed, true);
    assert.equal(r.session.live, true);
    await cx.waitForIdle("a", { timeoutMs: 8000 });
    assert.match(await cx.screen("a"), /ready args=--settings \S+ --resume fake-1/);
    assert.equal(await code(cx.resume("a")), "EXISTS");
  });

  test("a session lost without kill (reboot, crash) shows as dead and can be resumed", async () => {
    const info = JSON.parse(fs.readFileSync(path.join(tmp, ".clamux/run/a.json"), "utf8"));
    process.kill(info.pid, "SIGKILL"); // the host dies; its claude child loses the pty and exits
    for (let i = 0; i < 100 && cx.get("a").live; i++) await sleep(50);
    const s = cx.get("a");
    assert.equal(s.live, false);
    assert.equal(s.state, "dead");
    assert.equal(s.resumable, true);
    assert.equal((await cx.resume("a")).resumed, true);
    await cx.waitForIdle("a", { timeoutMs: 8000 });
  });

  test("a session that never started a conversation resumes fresh; forget deletes it", async () => {
    process.env.FAKE_NO_TRANSCRIPT = "1";
    fs.rmSync(path.join(tmp, "fake.jsonl"), { force: true });
    try {
      await cx.create("d", { dir: tmp });
    } finally {
      delete process.env.FAKE_NO_TRANSCRIPT;
    }
    await cx.waitForIdle("d", { timeoutMs: 8000 });
    await cx.kill("d");
    const r = await cx.resume("d");
    assert.equal(r.resumed, false);
    await cx.waitForIdle("d", { timeoutMs: 8000 });
    assert.doesNotMatch(await cx.screen("d"), /--resume/);

    assert.throws(() => cx.forget("d"), (e) => e.code === "BUSY"); // running sessions are killed first
    await cx.kill("d");
    cx.forget("d");
    assert.equal(cx.get("d"), undefined);
    assert.throws(() => cx.forget("d"), (e) => e.code === "NOT_FOUND");
  });

  test("a session whose `claude` cannot start fails with HOST_FAILED and leaves nothing behind", async () => {
    const saved = process.env.PATH;
    process.env.PATH = path.dirname(process.execPath); // node only: no `claude` anywhere
    try {
      assert.equal(await code(cx.create("broken", { dir: tmp })), "HOST_FAILED");
    } finally {
      process.env.PATH = saved;
    }
    assert.equal(cx.get("broken"), undefined);
  });

  test("create with sessionId continues a Claude conversation, in the directory it ran in", async () => {
    process.env.CLAUDE_CONFIG_DIR = path.join(tmp, ".claude");
    const id = "0b5e3f1c-7a2d-4c8e-9f10-2a3b4c5d6e7f";
    const project = fs.realpathSync(fs.mkdtempSync(path.join(tmp, "proj-")));
    const transcripts = path.join(tmp, ".claude/projects", project.replace(/[\\/:.]/g, "-"));
    fs.mkdirSync(transcripts, { recursive: true });
    fs.writeFileSync(path.join(transcripts, `${id}.jsonl`), `${JSON.stringify({ type: "user", cwd: project, sessionId: id })}\n`);

    assert.equal(await code(cx.create("u", { sessionId: "not-a-uuid" })), "INVALID");
    assert.equal(await code(cx.create("u", { sessionId: "11111111-2222-3333-4444-555555555555" })), "NOT_FOUND");
    assert.equal(await code(cx.create("u", { sessionId: id, dir: tmp })), "INVALID"); // claude --resume needs its own dir
    assert.equal(cx.get("u"), undefined);

    const s = await cx.create("u", { sessionId: id });
    assert.equal(s.cwd, project);
    await cx.waitForIdle("u", { timeoutMs: 8000 });
    assert.match(await cx.screen("u"), new RegExp(`ready args=--settings \\S+ --resume ${id}`));
    await cx.kill("u");
    cx.forget("u");
  });

  test("supports Antigravity CLI (agy / gemini alias) sessions, hooks, transcripts, and --conversation resume", async () => {
    const s = await cx.create("g", { dir: tmp, agent: "gemini" });
    assert.equal(s.agent, "agy");
    assert.equal((await cx.waitForIdle("g", { timeoutMs: 8000 })).state, "idle");
    assert.ok(fs.existsSync(path.join(tmp, ".gemini/config/hooks.json")));

    const r = await cx.ask("g", "olá agy", { timeoutMs: 10000 });
    assert.equal(r.session.state, "idle");
    assert.equal(r.answer, "agy-answer: olá agy");
    assert.equal(cx.lastAnswer("g"), "agy-answer: olá agy");

    await cx.kill("g");
    const res = await cx.resume("g");
    assert.equal(res.resumed, true);
    assert.equal(res.session.agent, "agy");
    await cx.waitForIdle("g", { timeoutMs: 8000 });
    assert.match(await cx.screen("g"), /agy-ready args=--dangerously-skip-permissions --conversation agy-conv-1/);
    await cx.kill("g");
    cx.forget("g");
  });
});
