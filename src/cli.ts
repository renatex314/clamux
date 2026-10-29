import fs from "node:fs";
import { parseArgs } from "node:util";
import { runHook } from "./hook.js";
import { fmtAge, snapshot, type DisplayState } from "./status.js";
import { attachSession } from "./attach.js";
import { configFile, SETTINGS } from "./paths.js";
import {
  capturePane, cleanStale, createSession, forgetSession, groupMembers, killSession, liveSessions, moveSession,
  readGroups, removeGroup, resumeSession, sendPrompt, setGroup, type Result,
} from "./sessions.js";

const HELP = `clamux - manage multiple Claude Code and Antigravity CLI (agy) sessions, with live working/idle status.

  clamux                          open the interactive dashboard (TUI)
  clamux new <name> [dir] [-g <group>] [-a claude|agy] [-s <session id>] [-d] [--notify|--no-notify] [-- <agent args>]
  clamux ls
  clamux attach <name>            (detach with Ctrl-b d)
  clamux send <name> <prompt...> [--force]
  clamux peek <name>
  clamux kill <name>              stop it; it stays saved and can be resumed
  clamux resume <name> [-d]       restart a saved session, continuing its conversation
  clamux resume --all             restart every saved session that is not running
  clamux forget <name>            delete a stopped session and its saved record
  clamux clean                    remove status files of sessions that are gone
  clamux group ls                 list groups and their defaults
  clamux group set <group> [--dir <dir>|--no-dir] [-a claude|agy] [--notify|--no-notify] [-- <agent args>]
                                  create a group, or change its defaults for new sessions
  clamux group rm <group>         delete a group (its sessions stay, without a group)
  clamux group move <name> [group]  put a session in a group (no group: take it out)
  clamux mcp                      run as an MCP server on stdio (for Claude Code, agy, and other MCP clients)
  clamux notify                   show a test desktop notification (and why it failed, if it did)
  clamux setup [--remove]         register the MCP server and a usage skill with Claude Code and agy

Status comes from lifecycle hooks (loaded per session via \`claude --settings\` for Claude Code,
and \`~/.gemini/config/hooks.json\` for Antigravity CLI).`;

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
  const gw = Math.max(5, ...rows.map((r) => (r.group ?? "-").length));
  console.log(`${"NAME".padEnd(w)}  ${"GROUP".padEnd(gw)}  ${"AGENT".padEnd(6)}  ${"STATE".padEnd(8)}  ${"FOR".padEnd(7)}  ${"DETAIL".padEnd(50)}  DIR`);
  for (const r of rows) {
    const s = r.state.padEnd(8);
    const state = color ? `\x1b[${COLORS[r.state]}m${s}\x1b[0m` : s;
    console.log(`${r.name.padEnd(w)}  ${(r.group ?? "-").padEnd(gw)}  ${r.agent.padEnd(6)}  ${state}  ${fmtAge(r.ageS).padEnd(7)}  ${r.detail.padEnd(50)}  ${r.cwd}`);
  }
}

function group([sub, ...rest]: string[], agentArgs: string[]): void {
  switch (sub) {
    case undefined:
    case "ls": {
      const groups = readGroups();
      const members = groupMembers();
      const names = Object.keys(groups).sort();
      if (names.length === 0) return void console.log("no groups (clamux group set <group> --dir <dir>)");
      for (const n of names) {
        const g = groups[n]!;
        const parts = [
          `dir: ${g.dir ?? "(current directory)"}`,
          `notify: ${g.notify === false ? "off" : "on"}`,
          ...(g.agent ? [`agent: ${g.agent}`] : []),
          ...(g.args?.length ? [`args: ${g.args.join(" ")}`] : []),
        ];
        const ss = members.get(n) ?? [];
        console.log(`${n}  ${parts.join("  ")}\n  sessions: ${ss.length ? ss.sort().join(", ") : "-"}`);
      }
      return;
    }
    case "set": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          dir: { type: "string" },
          "no-dir": { type: "boolean" },
          agent: { type: "string", short: "a" },
          notify: { type: "boolean" },
          "no-notify": { type: "boolean" },
          "no-args": { type: "boolean" },
        },
      });
      const [name] = positionals;
      if (!name) die("usage: clamux group set <group> [--dir <dir>|--no-dir] [-a claude|agy] [--notify|--no-notify] [--no-args | -- <agent args>]");
      const isNew = !readGroups()[name];
      must(setGroup(name, {
        dir: values["no-dir"] ? null : values.dir,
        // A new group notifies, like a session started from the CLI.
        notify: values["no-notify"] ? false : values.notify || isNew ? true : undefined,
        agent: values.agent as "claude" | "agy" | "gemini" | undefined,
        args: values["no-args"] ? null : agentArgs.length ? agentArgs : undefined,
      }));
      return void console.log(`${isNew ? "created" : "updated"} group '${name}'`);
    }
    case "rm": {
      if (!rest[0]) die("usage: clamux group rm <group>");
      must(removeGroup(rest[0]));
      return void console.log(`deleted group '${rest[0]}'`);
    }
    case "move": {
      if (!rest[0]) die("usage: clamux group move <name> [group]");
      must(moveSession(rest[0], rest[1] ?? null));
      return void console.log(rest[1] ? `moved '${rest[0]}' to '${rest[1]}'` : `took '${rest[0]}' out of its group`);
    }
    default:
      die(`unknown group command '${sub}' (ls, set, rm, move)`);
  }
}

async function main(): Promise<void> {
  let argv = process.argv.slice(2);
  let claudeArgs: string[] = [];
  const dd = argv.indexOf("--");
  if (dd >= 0) [argv, claudeArgs] = [argv.slice(0, dd), argv.slice(dd + 1)];

  const [cmd = "tui", ...rest] = argv;
  if (cmd === "hook") return runHook(rest[0]);
  if (cmd === "host") { // internal: the detached process that owns one session
    const name = rest[0] ?? die("usage: clamux host <name>");
    const { hostMain } = await import("./host.js");
    return hostMain(name, JSON.parse(fs.readFileSync(configFile(name), "utf8")), SETTINGS);
  }
  if (cmd === "-h" || cmd === "--help" || cmd === "help") return void console.log(HELP);

  switch (cmd) {
    case "setup": {
      const { values } = parseArgs({ args: rest, options: { remove: { type: "boolean" } } });
      const { setup, unsetup } = await import("./setup.js");
      const r = values.remove ? unsetup() : setup();
      r.lines.forEach((l) => console.log(l));
      if (!r.ok) process.exit(1);
      return;
    }
    case "notify": {
      const { notifyTest, NOTIFY_LOG } = await import("./notify.js");
      const r = notifyTest("clamux", "Test notification - if you can see this, notifications work");
      if (r.out) console.log(r.out);
      console.log(r.ok
        ? `notification sent; if none appeared, check the OS notification settings (errors from sessions go to ${NOTIFY_LOG})`
        : "the notification failed (see above)");
      if (!r.ok) process.exit(1);
      return;
    }
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
        options: {
          agent: { type: "string", short: "a" },
          session: { type: "string", short: "s" },
          group: { type: "string", short: "g" },
          detach: { type: "boolean", short: "d" },
          notify: { type: "boolean" },
          "no-notify": { type: "boolean" },
        },
      });
      const [name, dir] = positionals;
      if (!name) die("usage: clamux new <name> [dir] [-g <group>] [-a claude|agy] [-s <session id>] [-d] [--notify|--no-notify] [-- <agent args>]");
      must(await createSession(name, dir, {
        // Notifications are on by default, unless the group says otherwise.
        notify: values["no-notify"] ? false : values.notify ? true : (values.group ? readGroups()[values.group]?.notify : undefined) ?? true,
        agent: values.agent as "claude" | "agy" | "gemini" | undefined,
        sessionId: values.session,
        group: values.group,
        claudeArgs: claudeArgs.length ? claudeArgs : undefined,
      }));
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
    case "group":
      return group(rest, claudeArgs);
    case "clean": {
      const stale = cleanStale();
      return void console.log(`removed ${stale.length} stale status file(s)`);
    }
    default:
      die(`unknown command '${cmd}'\n\n${HELP}`);
  }
}

main().catch((e) => die(e instanceof Error ? e.message : String(e)));
