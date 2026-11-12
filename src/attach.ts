import { connect, readMessages, send } from "./ipc.js";
import { pidAlive, readRegistry } from "./registry.js";
import { fail, type Result } from "./sessions.js";
import { markSeen } from "./status.js";

export const PREFIX = "\x02"; // Ctrl-b: Ctrl-b d detaches, Ctrl-b Ctrl-b sends a literal Ctrl-b
const ALT_SCREEN_ON = "\x1b[?1049h";
/**
 * Leaves the terminal the way we found it. While attached, the app can switch the real terminal into modes
 * (Claude Code turns on the kitty keyboard protocol, modifyOtherKeys, mouse and focus reporting); left on,
 * they would garble the dashboard or the shell after detaching.
 */
const RESTORE_TERMINAL =
  "\x1b[?1049l\x1b[?25h" + // main screen, cursor visible
  "\x1b[=0;1u\x1b[>4;0m" + // kitty keyboard flags off, modifyOtherKeys off
  "\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1004l\x1b[?2004l\x1b[?2031l"; // mouse, focus, paste, theme reports

/**
 * Splits terminal input into keys and whole control sequences. Claude Code switches the terminal into an
 * enhanced keyboard mode (kitty protocol, xterm modifyOtherKeys), where Ctrl-b arrives as an escape sequence
 * instead of \x02, and turns on mouse and focus reports, which arrive between any two keys.
 */
const TOKEN = /\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1bO[\s\S]|[\s\S]/gu;
/** A control sequence cut off at the end of a read; it is completed by the next one. */
const PARTIAL = /\x1b\[[\x30-\x3f]+[\x20-\x2f]*$/u;
/** Kitty's codes for the modifier keys themselves (Shift, Ctrl, Alt, Super, ... pressed alone). */
const isModifierKey = (code: number) => code >= 57441 && code <= 57454;

type KeyKind = "ctrl-b" | "d" | "neutral" | "other";

/**
 * What a token means for the detach prefix. "neutral" is input that is not a key press - a key release, a
 * modifier key alone, a mouse or focus report, a terminal reply - and must not cancel a pending Ctrl-b.
 */
export function keyKind(tok: string): KeyKind {
  if (tok === PREFIX) return "ctrl-b";
  if (tok === "d" || tok === "D") return "d"; // D: Caps Lock on
  if (/^\x1b\[[<?>=]/u.test(tok) || /^\x1b\[[IO]$/u.test(tok) || /^\x1b\]/u.test(tok) || /^\x1b\[\d+;\d+R$/u.test(tok)) {
    return "neutral"; // mouse (SGR), terminal replies, focus in/out, OSC replies, cursor position
  }
  let code: number, mods: number;
  // kitty: CSI code[:shifted[:base]] ; mods[:event] [; text] u
  const kitty = /^\x1b\[(\d+)(?::\d*)*(?:;(\d*)(?::(\d+))?)?(?:;[\d:]*)?u$/u.exec(tok);
  if (kitty) {
    code = Number(kitty[1]);
    mods = Number(kitty[2] || 1);
    if (kitty[3] === "3" || isModifierKey(code)) return "neutral"; // key release, or Ctrl/Shift/... alone
  } else {
    const mok = /^\x1b\[27;(\d+);(\d+)~$/u.exec(tok);
    if (!mok) return "other";
    mods = Number(mok[1]);
    code = Number(mok[2]);
  }
  const held = (mods - 1) & 0b111111; // Caps Lock (64) and Num Lock (128) do not count
  if ((code === 98 || code === 66) && held === 4) return "ctrl-b";
  if ((code === 100 || code === 68) && (held === 0 || held === 1)) return "d";
  return "other";
}

/**
 * The Ctrl-b prefix, as tmux has it: Ctrl-b d detaches, Ctrl-b Ctrl-b sends a literal Ctrl-b, Ctrl-b and any
 * other key sends both. Feed it every read from the terminal; it returns what to forward to the session.
 */
export function createPrefixFilter(): (chunk: string) => { out: string; detach: boolean } {
  let pending: string | null = null; // the Ctrl-b that started the prefix, as the terminal sent it
  let carry = "";
  return (chunk) => {
    let data = carry + chunk;
    carry = PARTIAL.exec(data)?.[0] ?? "";
    if (carry) data = data.slice(0, -carry.length);
    let out = "";
    for (const tok of data.match(TOKEN) ?? []) {
      const kind = keyKind(tok);
      if (kind === "neutral") out += tok;
      else if (pending === null) {
        if (kind === "ctrl-b") pending = tok;
        else out += tok;
      } else if (kind === "d") {
        return { out, detach: true };
      } else {
        out += kind === "ctrl-b" ? tok : pending + tok;
        pending = null;
      }
    }
    return { out, detach: false };
  };
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
      stdout.write(RESTORE_TERMINAL);
      s.destroy();
      markSeen(name); // whatever it said while attached has been on screen
      resolve({ ok: true });
    };

    const onResize = () => send(s, { t: "resize", cols: stdout.columns, rows: stdout.rows });

    const filter = createPrefixFilter();
    const onKey = (chunk: string) => {
      const { out, detach } = filter(chunk);
      if (out) send(s, { t: "input", d: out });
      if (detach) {
        send(s, { t: "detach" });
        finish();
      }
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
