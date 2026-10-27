import fs from "node:fs";
import { parseArgs } from "node:util";
import { runHook } from "./hook.js";
import { fmtAge, snapshot, type DisplayState } from "./status.js";
import { attachSession } from "./attach.js";
import { configFile, SETTINGS } from "./paths.js";
import {
  capturePane, cleanStale, createSession, forgetSession, killSession, liveSessions, resumeSession, sendPrompt,
  type Result,
} from "./sessions.js";

const HELP = `clamux - manage multiple Claude Code sessions, with live working/idle status.

  clamux                          open the interactive dashboard (TUI)
  clamux new <name> [dir] [-d] [--no-notify] [-- <claude args>]
  clamux ls
  clamux attach <name>            (detach with Ctrl-b d)
  clamux send <name> <prompt...> [--force]
  clamux peek <name>
  clamux kill <name>              stop it; it stays saved and can be resumed
  clamux resume <name> [-d]       restart a saved session, continuing its conversation
  clamux resume --all             restart every saved session that is not running
  clamux forget <name>            delete a stopped session and its saved record
  clamux clean                    remove status files of sessions that are gone
  clamux mcp                      run as an MCP server on stdio (for Claude Code and other MCP clients)

Status comes from Claude Code hooks loaded per session via \`claude --settings\`;
~/.claude/settings.json is never modified.`;

const COLORS: Record<DisplayState, string> = {
  working: "33", waiting: "31;1", idle: "32", starting: "36", dead: "31", ended: "90", "stale?": "35",
};

function die(msg: string): never {
  console.error(`clamux: ${msg}`);
  process.exit(1);
}

function must(r: Result): void {
  if (!r.ok) die(r.error);
}

function ls(): void {
  const rows = snapshot(liveSessions());
  if (rows.length === 0) return void console.log("no sessions (clamux new <name>)");
  const color = process.stdout.isTTY;
  const w = Math.max(4, ...rows.map((r) => r.name.length));
  console.log(`${"NAME".padEnd(w)}  ${"STATE".padEnd(8)}  ${"FOR".padEnd(7)}  ${"DETAIL".padEnd(50)}  DIR`);
  for (const r of rows) {
    const s = r.state.padEnd(8);
    const state = color ? `\x1b[${COLORS[r.state]}m${s}\x1b[0m` : s;
    console.log(`${r.name.padEnd(w)}  ${state}  ${fmtAge(r.ageS).padEnd(7)}  ${r.detail.padEnd(50)}  ${r.cwd}`);
  }
}

async function main(): Promise<void> {
  let argv = process.argv.slice(2);
  let claudeArgs: string[] = [];
  const dd = argv.indexOf("--");
  if (dd >= 0) [argv, claudeArgs] = [argv.slice(0, dd), argv.slice(dd + 1)];

  const [cmd = "tui", ...rest] = argv;
  if (cmd === "hook") return runHook();
  if (cmd === "host") { // internal: the detached process that owns one session
    const name = rest[0] ?? die("usage: clamux host <name>");
    const { hostMain } = await import("./host.js");
    return hostMain(name, JSON.parse(fs.readFileSync(configFile(name), "utf8")), SETTINGS);
  }
  if (cmd === "-h" || cmd === "--help" || cmd === "help") return void console.log(HELP);

  switch (cmd) {
    case "mcp": {
      const { runMcp } = await import("./mcp.js");
      return runMcp();
    }
    case "tui": {
      if (!process.stdin.isTTY) die("the dashboard needs an interactive terminal");
      const { runTui } = await import("./tui.js");
      return runTui();
    }
    case "ls":
      return ls();
    case "new": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { detach: { type: "boolean", short: "d" }, "no-notify": { type: "boolean" } },
      });
      const [name, dir = "."] = positionals;
      if (!name) die("usage: clamux new <name> [dir] [-d] [--no-notify] [-- <claude args>]");
      must(await createSession(name, dir, { notify: !values["no-notify"], claudeArgs }));
      console.log(`started '${name}'`);
      if (!values.detach) must(await attachSession(name));
      return;
    }
    case "attach": {
      if (!rest[0]) die("usage: clamux attach <name>");
      return must(await attachSession(rest[0]));
    }
    case "send": {
      const { values, positionals } = parseArgs({
        args: rest, allowPositionals: true, options: { force: { type: "boolean" } },
      });
      const [name, ...words] = positionals;
      if (!name || words.length === 0) die("usage: clamux send <name> <prompt...> [--force]");
      const row = snapshot(liveSessions()).find((r) => r.name === name);
      if (row && (row.state === "working" || row.state === "waiting") && !values.force) {
        die(`'${name}' is ${row.state}; the text would be typed into a busy session. Use --force to send anyway.`);
      }
      must(await sendPrompt(name, words.join(" ")));
      return void console.log(`sent to '${name}'`);
    }
    case "peek": {
      if (!rest[0]) die("usage: clamux peek <name>");
      if (!liveSessions().has(rest[0])) die(`no live session '${rest[0]}'`);
      return void console.log(capturePane(rest[0]).trimEnd());
    }
    case "kill": {
      if (!rest[0]) die("usage: clamux kill <name>");
      must(await killSession(rest[0]));
      return void console.log(`killed '${rest[0]}'`);
    }
    case "resume": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { detach: { type: "boolean", short: "d" }, all: { type: "boolean" } },
      });
      if (values.all) {
        const todo = snapshot(liveSessions()).filter((r) => r.resumable);
        for (const r of todo) {
          const res = await resumeSession(r.name);
          console.log(res.ok ? `resumed '${r.name}'${res.resumed ? "" : " (fresh: no conversation recorded)"}` : `${r.name}: ${res.error}`);
        }
        return void (todo.length === 0 && console.log("nothing to resume"));
      }
      const [name] = positionals;
      if (!name) die("usage: clamux resume <name> [-d] | clamux resume --all");
      const res = await resumeSession(name);
      if (!res.ok) die(res.error);
      console.log(`resumed '${name}'${res.resumed ? "" : " (fresh: no conversation recorded)"}`);
      if (!values.detach) must(await attachSession(name));
      return;
    }
    case "forget": {
      if (!rest[0]) die("usage: clamux forget <name>");
      must(forgetSession(rest[0]));
      return void console.log(`forgot '${rest[0]}'`);
    }
    case "clean": {
      const stale = cleanStale();
      return void console.log(`removed ${stale.length} stale status file(s)`);
    }
    default:
      die(`unknown command '${cmd}'\n\n${HELP}`);
  }
}

main().catch((e) => die(e instanceof Error ? e.message : String(e)));
