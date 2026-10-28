import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "dist/cli.js");
const tmp = fs.mkdtempSync(process.platform === "win32" ? path.join(process.env.TEMP, "clx-") : "/tmp/clx-");
const bin = path.join(tmp, "bin");
const calls = path.join(tmp, "calls.log");
fs.mkdirSync(bin);

// A `claude` that only records how it was called.
if (process.platform === "win32") {
  fs.writeFileSync(path.join(bin, "claude.cmd"), `@echo %* >> "${calls}"\r\n`);
} else {
  fs.writeFileSync(path.join(bin, "claude"), `#!/bin/sh\necho "$@" >> "${calls}"\n`, { mode: 0o755 });
}

const run = (args, pathDirs = [bin]) =>
  spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: { ...process.env, HOME: tmp, USERPROFILE: tmp, CLAUDE_CONFIG_DIR: "", PATH: [...pathDirs, path.dirname(process.execPath)].join(path.delimiter) },
  });
const logged = () => (fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").trim().split(/\r?\n/).map((l) => l.trim()) : []);
const skill = path.join(tmp, ".claude/skills/clamux/SKILL.md");

describe("clamux setup", () => {
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  test("registers the server at user scope with an absolute command, and installs the skill", () => {
    const r = run(["setup"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const [remove, add] = logged();
    assert.equal(remove, "mcp remove clamux --scope user");
    assert.equal(add, `mcp add --scope user clamux -- ${process.execPath} ${cli} mcp`);
    const text = fs.readFileSync(skill, "utf8");
    assert.match(text, /^---\nname: clamux\ndescription: .+\n---/);
    assert.match(text, /create_session/);
  });

  test("uses the bare `clamux` command when it is on PATH (a global install)", () => {
    fs.rmSync(calls);
    const shim = path.join(bin, process.platform === "win32" ? "clamux.cmd" : "clamux");
    fs.writeFileSync(shim, process.platform === "win32" ? "@exit /b 0\r\n" : "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const r = run(["setup"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(logged()[1], "mcp add --scope user clamux -- clamux mcp");
    fs.rmSync(shim);
  });

  test("still installs the skill, and fails loudly, when `claude` is missing", () => {
    fs.rmSync(path.dirname(skill), { recursive: true });
    const r = run(["setup"], []);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /could not register the MCP server/);
    assert.match(r.stdout, /claude mcp add --scope user clamux/);
    assert.ok(fs.existsSync(skill));
  });

  test("--remove undoes both", () => {
    fs.rmSync(calls, { force: true });
    const r = run(["setup", "--remove"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(logged(), ["mcp remove clamux --scope user"]);
    assert.equal(fs.existsSync(path.dirname(skill)), false);
  });

  test("also configures agy (MCP, skill and hooks.json) when `agy` is on PATH", () => {
    fs.rmSync(calls, { force: true });
    const agyCalls = path.join(tmp, "agy-calls.log");
    const agyShim = path.join(bin, process.platform === "win32" ? "agy.cmd" : "agy");
    if (process.platform === "win32") {
      fs.writeFileSync(agyShim, `@echo %* >> "${agyCalls}"\r\n`);
    } else {
      fs.writeFileSync(agyShim, `#!/bin/sh\necho "$@" >> "${agyCalls}"\n`, { mode: 0o755 });
    }
    const r = run(["setup"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const agyLog = fs.readFileSync(agyCalls, "utf8").trim().split(/\r?\n/).map((l) => l.trim());
    assert.equal(agyLog[0], "mcp remove clamux");
    assert.equal(agyLog[1], `mcp add clamux -- ${process.execPath} ${cli} mcp`);
    assert.ok(fs.existsSync(path.join(tmp, ".gemini/config/skills/clamux/SKILL.md")));
    assert.ok(fs.existsSync(path.join(tmp, ".gemini/config/hooks.json")));

    const rm = run(["setup", "--remove"]);
    assert.equal(rm.status, 0, rm.stdout + rm.stderr);
    assert.equal(fs.existsSync(path.join(tmp, ".gemini/config/skills/clamux")), false);
    assert.equal(fs.existsSync(path.join(tmp, ".gemini/config/hooks.json")), false);
    fs.rmSync(agyShim, { force: true });
  });

  test("keeps the user's own agy hooks, and never overwrites a hooks.json it cannot parse", () => {
    const agyShim = path.join(bin, process.platform === "win32" ? "agy.cmd" : "agy");
    if (process.platform === "win32") fs.writeFileSync(agyShim, "@echo off\r\n");
    else fs.writeFileSync(agyShim, "#!/bin/sh\n", { mode: 0o755 });
    const hooks = path.join(tmp, ".gemini/config/hooks.json");
    fs.mkdirSync(path.dirname(hooks), { recursive: true });

    fs.writeFileSync(hooks, JSON.stringify({ mine: { Stop: [{ type: "command", command: "echo hi" }] } }));
    assert.equal(run(["setup"]).status, 0);
    const merged = JSON.parse(fs.readFileSync(hooks, "utf8"));
    assert.deepEqual(merged.mine, { Stop: [{ type: "command", command: "echo hi" }] });
    assert.ok(merged.clamux);
    run(["setup", "--remove"]);
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(hooks, "utf8"))), ["mine"]);

    const broken = '{ // my hooks\n  "mine": {}\n}';
    fs.writeFileSync(hooks, broken);
    const r = run(["setup"]);
    assert.notEqual(r.status, 0);
    assert.match(r.stdout + r.stderr, /could not install the agy status hooks: .*not valid JSON/);
    assert.equal(fs.readFileSync(hooks, "utf8"), broken);

    fs.rmSync(path.dirname(hooks), { recursive: true, force: true });
    fs.rmSync(agyShim, { force: true });
  });
});
