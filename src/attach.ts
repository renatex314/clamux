import { connect, readMessages, send } from "./ipc.js";
import { pidAlive, readRegistry } from "./registry.js";
import { fail, type Result } from "./sessions.js";

const PREFIX = "\x02"; // Ctrl-b: Ctrl-b d detaches, Ctrl-b Ctrl-b sends a literal Ctrl-b
const ALT_SCREEN_ON = "\x1b[?1049h";
const ALT_SCREEN_OFF = "\x1b[?1049l\x1b[?25h";

// Claude Code can switch the terminal into an enhanced keyboard mode (kitty protocol or
// xterm modifyOtherKeys), where Ctrl-b arrives as an escape sequence instead of \x02.
const KEY_TOKEN = /\x1b\[\d+(?:;\d+(?::\d+)?)*u|\x1b\[27;\d+;\d+~|[\s\S]/gu;

function keyOf(tok: string): "ctrl-b" | "d" | undefined {
  if (tok === PREFIX) return "ctrl-b";
  if (tok === "d") return "d";
  let code: number, mods: number;
  const kitty = /^\x1b\[(\d+)(?:;(\d+)(?::(\d+))?)?u$/.exec(tok);
  if (kitty) {
    if (kitty[3] === "3") return undefined; // key release
    code = Number(kitty[1]);
    mods = Number(kitty[2] ?? 1);
  } else {
    const mok = /^\x1b\[27;(\d+);(\d+)~$/.exec(tok);
    if (!mok) return undefined;
    mods = Number(mok[1]);
    code = Number(mok[2]);
  }
  if (code === 98 && mods === 5) return "ctrl-b";
  if (code === 100 && mods === 1) return "d";
  return undefined;
}

/** Connects this terminal to the session until the user detaches or the session exits. */
export async function attachSession(name: string): Promise<Result> {
  const info = readRegistry(name);
  if (!info || !pidAlive(info.pid)) return fail("NOT_FOUND", `no live session '${name}'`);
  const { stdin, stdout } = process;
  if (!stdin.isTTY || !stdout.isTTY) return fail("INVALID", "attach needs an interactive terminal");

  let sock;
  try {
    sock = await connect(info.endpoint);
  } catch (e) {
    return fail("HOST_FAILED", e instanceof Error ? e.message : String(e));
  }

  return new Promise<Result>((resolve) => {
    const s = sock;
    let done = false;
    let pending = false; // saw the prefix key, waiting for the next one

    const finish = () => {
      if (done) return;
      done = true;
      stdin.off("data", onKey);
      stdout.off("resize", onResize);
      try {
        stdin.setRawMode(false);
      } catch {
        // not a TTY anymore
      }
      stdin.pause();
      stdout.write(ALT_SCREEN_OFF);
      s.destroy();
      resolve({ ok: true });
    };

    const onResize = () => send(s, { t: "resize", cols: stdout.columns, rows: stdout.rows });

    const onKey = (chunk: string) => {
      let out = "";
      for (const tok of chunk.match(KEY_TOKEN) ?? []) {
        const isPrefix = keyOf(tok) === "ctrl-b";
        if (pending) {
          pending = false;
          if (keyOf(tok) === "d") {
            if (out) send(s, { t: "input", d: out });
            send(s, { t: "detach" });
            return finish();
          }
          out += isPrefix ? tok : PREFIX + tok;
        } else if (isPrefix) {
          pending = true;
        } else {
          out += tok;
        }
      }
      if (out) send(s, { t: "input", d: out });
    };

    readMessages(s, (m) => {
      if (m.t === "snapshot" || m.t === "out") stdout.write(String(m.d ?? ""));
      else if (m.t === "exit") finish();
    });
    s.on("close", finish);
    s.on("error", finish);

    stdout.write(ALT_SCREEN_ON);
    stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    stdin.resume();
    stdin.on("data", onKey);
    stdout.on("resize", onResize);
    send(s, { t: "attach", cols: stdout.columns, rows: stdout.rows });
  });
}
