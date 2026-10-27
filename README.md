# clamux

A terminal dashboard for running several Claude Code sessions side by side and seeing at a glance which ones are working, idle, or waiting for you. Runs natively on macOS, Linux and Windows - no tmux or other multiplexer needed.

Status comes from Claude Code hooks, not screen scraping. The hooks are loaded per session with `claude --settings ~/.clamux/settings.json`, so `~/.claude/settings.json` is never touched and only sessions started through clamux report status.

## Install

```bash
npm install -g clamux      # the `clamux` command (dashboard + CLI)
npm install clamux         # the SDK, as a dependency of your project
```

Requires Node 20+ and the `claude` CLI on your PATH. To work on clamux itself, see Setup below.

## Setup (from source)

```bash
npm install
npm run build
ln -s "$PWD/dist/cli.js" ~/.local/bin/clamux   # optional (macOS/Linux): run `clamux` from anywhere
```

On Windows, run `npm link` instead (or call `node dist\cli.js`).

`node-pty` provides the pseudo-terminal. It ships prebuilt binaries for macOS and Windows; on Linux it compiles on install, so you need a C++ toolchain (`build-essential` or equivalent).

## Use

`clamux` with no arguments opens the dashboard.

| Key | Action |
|---|---|
| `↑` `↓` / `j` `k` | select a session |
| `Enter` | attach to it; press `Ctrl-b` then `d` to detach and come back to the dashboard |
| `n` | new session (asks for a name, then a directory) |
| `s` | type a prompt into the selected session (asks first if it is busy) |
| `r` | resume the selected session if it is not running |
| `x` | kill the selected session (it stays saved, so `r` brings it back) |
| `d` | delete the selected session and its saved record |
| `c` | remove leftover status entries |
| `q` | quit (sessions keep running) |

Scriptable subcommands: `clamux new <name> [dir] [-d] [--no-notify] [-- <claude args>]`, `ls`, `attach`, `send <name> <prompt...> [--force]`, `peek`, `kill`, `resume <name> [-d]`, `resume --all`, `forget`, `clean`.

## Saved sessions

Every session is saved when you create it: `~/.clamux/saved/<name>.json` records its directory, the `claude` arguments, whether it notifies, and the id of the Claude conversation it holds (kept current by the hooks, so it follows `/clear`). Killing a session, rebooting, or a crash only stops the process - the record stays, and the session shows in the list as `ended` or `dead` with `resumable`. `clamux resume <name>` (or `r` in the dashboard) starts it again with `claude --resume <id>`, so the conversation continues where it left off. `clamux resume --all` restarts everything that is not running, e.g. after a reboot.

If the session never had a conversation (nothing was sent before it stopped), there is nothing to resume, so it starts fresh with the same directory and arguments. `forget` (`d` in the dashboard) deletes the record; a name that is still saved cannot be reused by `new` until then.

A desktop notification fires when a session goes from working to idle, or needs your permission (macOS: Notification Center with a sound; Windows: toast; Linux: `notify-send`). Pass `--no-notify` to `new` to disable it.

## How it works

Each session is a small detached host process (`clamux host <name>`) that owns the Claude Code process through a pseudo-terminal and keeps a virtual screen of what it draws. The host listens on a unix socket (a named pipe on Windows). `attach` connects your terminal to it (replaying the current screen first), `send` and `press` write input to it, and the host also keeps a plain-text copy of the screen in `~/.clamux/run/` so the dashboard preview and `peek` are cheap. Sessions keep running when you close the dashboard or your terminal.

## SDK

The package also exports a typed client for driving sessions from your own code:

```ts
import { Clamux, ClamuxError } from "clamux";

const cx = new Clamux();
await cx.create("refactor", { dir: "~/projects/app" }); // detached; notify defaults to false here
await cx.waitForIdle("refactor");                       // wait for Claude to start up

const { screen, transcriptPath } = await cx.ask("refactor", "Rename foo to bar", { timeoutMs: 120_000 });

for await (const change of cx.watch()) {                // every state change, until you abort
  console.log(change.name, change.from, "->", change.to);
}
```

| Method | |
|---|---|
| `list()` / `get(name)` | session snapshots: `name`, `state`, `detail` (current tool), `ageS`, `cwd`, `live`, `sessionId`, `transcriptPath`, `resumable` |
| `create(name, { dir, notify, claudeArgs })` | start a session (async) |
| `send(name, prompt, { force })` | type a prompt; throws `BUSY` if the session is working/waiting |
| `ask(name, prompt, opts)` | `send` then wait until Claude finishes that turn (working -> idle); returns the screen |
| `waitFor(name, predicate, { timeoutMs, pollMs, signal })` / `waitForIdle` | wait for a condition |
| `press(name, ...keys)` | key names (`Enter`, `Down`, `Escape`, `C-c`, ...) or literal text, e.g. `press("x", "y")` to answer a permission prompt |
| `screen(name)` | the exact screen right now (async) |
| `peek(name)` | the screen from a file refreshed ~8x/second (sync, may trail slightly) |
| `watch({ pollMs, signal })` | async iterator of `{ name, from, to, session }` |
| `kill(name)` | stop a session; it stays saved (`resumable: true`) |
| `resume(name)` | restart a saved session and continue its conversation; returns `{ session, resumed }` |
| `forget(name)` | delete a stopped session and its saved record (`BUSY` if it is running) |
| `attach` / `clean` | as in the CLI (`attach` is async) |

Errors are `ClamuxError` with a `code`: `INVALID`, `EXISTS`, `NOT_FOUND`, `BUSY`, `TIMEOUT`, `ABORTED`, `HOST_FAILED`.

Notes:
- `ask()` returns the visible screen, not a structured answer. For the full conversation, read the JSONL at `transcriptPath`.
- If Claude stops to ask permission the session sits in `waiting`, so `ask()` will time out. Use `watch()` to notice it and `press()` to answer, or set `timeoutMs`.
- Sessions you create stay alive after your script exits; `kill` them when done.
- The SDK and the dashboard share the same sessions as long as they run as the same user (same home directory).

## States

`working` (with the current tool), `idle`, `waiting` (needs permission or input), `starting` (e.g. sitting on the folder-trust prompt), `stale?` (working but no event for 15 minutes), `dead` (the session host vanished), `ended`.

## Layout

- `src/hook.ts` – the hook Claude Code calls on each event; writes `~/.clamux/status/<name>.json`
- `src/status.ts` – reads status files and derives the displayed state
- `src/host.ts` – the per-session host: pty, virtual screen, socket server
- `src/sessions.ts`, `src/registry.ts`, `src/attach.ts` – create / resume / send / kill / attach, and discovering live sessions
- `src/saved.ts` – the per-session records that make resuming possible
- `src/ipc.ts`, `src/keys.ts`, `src/notify.ts`, `src/env.ts` – protocol framing, key names, desktop notifications, environment hygiene
- `src/tui.tsx` – the Ink dashboard (loaded lazily so hooks start fast)
- `src/cli.ts` – entry point and subcommands
- `src/client.ts`, `src/index.ts`, `src/errors.ts` – the SDK

`npm run typecheck` checks types; `npm run build` bundles to `dist/` and emits type declarations; `npm test` builds and runs the SDK tests (they use a fake `claude`, an isolated `HOME` and real pseudo-terminals, so they never touch your real sessions or your subscription).
