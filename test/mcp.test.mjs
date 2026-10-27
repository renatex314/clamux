import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(process.platform === "win32" ? path.join(process.env.TEMP, "clx-") : "/tmp/clx-");
const bin = path.join(tmp, "bin");
fs.mkdirSync(bin);

const fake = path.join(root, "test/fake-claude.mjs");
if (process.platform === "win32") {
  fs.writeFileSync(path.join(bin, "claude.cmd"), `@"${process.execPath}" "${fake}" %*\r\n`);
} else {
  fs.writeFileSync(path.join(bin, "claude"), `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`, { mode: 0o755 });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe("clamux MCP server", () => {
  let client;
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    return { text: r.content.map((c) => c.text).join("\n"), isError: r.isError === true };
  };

  before(async () => {
    // The server is a separate process with an isolated HOME and the fake `claude` on its PATH.
    client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: [path.join(root, "dist/cli.js"), "mcp"],
      env: {
        ...process.env, HOME: tmp, USERPROFILE: tmp, PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        CLAMUX_CLI: path.join(root, "dist/cli.js"), FAKE_WORK_MS: "2000",
      },
    }));
  });

  after(async () => {
    for (const s of JSON.parse((await call("list_sessions")).text).filter((x) => x.live)) await call("kill_session", { name: s.name });
    await client.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("advertises the tools with schemas and instructions", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "ask", "create_session", "forget_session", "get_answer", "kill_session", "list_sessions",
      "press_keys", "read_screen", "resume_session", "send_prompt", "wait_for_session",
    ]);
    assert.deepEqual(tools.find((t) => t.name === "ask").inputSchema.required.sort(), ["name", "prompt"]);
    assert.match(client.getInstructions(), /create_session/);
  });

  test("create_session starts a session that list_sessions reports as idle", async () => {
    const r = await call("create_session", { name: "m", dir: tmp });
    assert.equal(r.isError, false, r.text);
    assert.equal(JSON.parse(r.text).state, "idle");
    const list = JSON.parse((await call("list_sessions")).text);
    assert.equal(list.find((s) => s.name === "m").live, true);
  });

  test("ask returns Claude's final reply, not the screen", async () => {
    const r = await call("ask", { name: "m", prompt: "hello mcp" });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.text, "answer: hello mcp");
    assert.equal((await call("get_answer", { name: "m" })).text, "answer: hello mcp");
    assert.match((await call("read_screen", { name: "m" })).text, /answer: hello mcp/);
  });

  test("ask that outlives its timeout reports the state instead of failing; wait_for_session finishes it", async () => {
    const r = await call("ask", { name: "m", prompt: "slow one", timeout_seconds: 1 });
    assert.equal(r.isError, false);
    assert.match(r.text, /Session 'm' is working/);
    assert.match(r.text, /wait_for_session/);
    const w = await call("wait_for_session", { name: "m", timeout_seconds: 20 });
    assert.equal(w.text, "answer: slow one");
  });

  test("errors come back as tool errors with a code", async () => {
    assert.match((await call("ask", { name: "nope", prompt: "x" })).text, /^NOT_FOUND/);
    assert.equal((await call("ask", { name: "nope", prompt: "x" })).isError, true);
    assert.match((await call("create_session", { name: "bad name!" })).text, /^INVALID/);
    await call("send_prompt", { name: "m", prompt: "busy" });
    await sleep(300);
    assert.match((await call("send_prompt", { name: "m", prompt: "again" })).text, /^BUSY/);
    await call("wait_for_session", { name: "m", timeout_seconds: 20 });
  });

  test("press_keys types into the session", async () => {
    await call("press_keys", { name: "m", keys: ["typed via keys", "Enter"] });
    await sleep(300);
    assert.equal((await call("wait_for_session", { name: "m", timeout_seconds: 20 })).text, "answer: typed via keys");
  });

  test("kill, resume and forget manage the saved session", async () => {
    assert.match((await call("kill_session", { name: "m" })).text, /Killed/);
    assert.equal(JSON.parse((await call("list_sessions")).text).find((s) => s.name === "m").resumable, true);
    assert.match((await call("resume_session", { name: "m" })).text, /^Resumed 'm'\./);
    assert.match((await call("forget_session", { name: "m" })).text, /^BUSY/);
    await call("kill_session", { name: "m" });
    assert.match((await call("forget_session", { name: "m" })).text, /Forgot/);
    assert.deepEqual(JSON.parse((await call("list_sessions")).text), []);
  });
});
