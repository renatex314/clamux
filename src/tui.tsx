import type { EventEmitter } from "node:events";
import { useEffect, useState } from "react";
import { Box, Text, render, useApp, useInput, usePaste, useStdin, useStdout } from "ink";
import TextInput from "ink-text-input";
import { fmtAge, markSeen, snapshot, type DisplayState, type Row } from "./status.js";
import { attachSession, createPrefixFilter } from "./attach.js";
import { DirPicker } from "./dirpicker.js";
import {
  capturePane, cleanStale, createSession, forgetSession, killSession, liveSessions, moveSession, openInput, pasteInto, readAccounts, renameSession, readFolded,
  readGroups, removeGroup, writeFolded, resumeSession, sendPrompt, setGroup, validName, type Agent, type Group,
} from "./sessions.js";

const COLOR: Record<DisplayState, string> = {
  working: "yellow", waiting: "red", idle: "green", starting: "cyan", dead: "red", ended: "gray", "stale?": "magenta",
};
/** Idle with a reply nobody has looked at yet. */
const UNREAD = "greenBright";
const colorOf = (r: Row) => (r.unread ? UNREAD : COLOR[r.state]);
const stateOf = (r: Row) => (r.unread ? "unread" : r.state);

type Mode =
  | { kind: "list" }
  | { kind: "new-name"; then: "dir" | "id"; group: string | null }
  | { kind: "new-dir"; name: string; group: string | null }
  | { kind: "new-id"; name: string; group: string | null }
  | { kind: "group-name" }
  | { kind: "group-dir"; name: string }
  | { kind: "group-notify"; name: string; dir: string }
  | { kind: "move"; name: string; to: number }
  | { kind: "keys"; name: string }
  | { kind: "send"; name: string }
  | { kind: "rename"; name: string }
  | { kind: "confirm"; question: string; run: () => void | Promise<void> };

interface Action { attach: string }

/** A line of the session list: a group header, a session (indented under its group), or a label. */
type Item =
  | { kind: "group"; name: string; count: number; folded: boolean }
  | { kind: "session"; row: Row; indent: boolean }
  | { kind: "label"; text: string };

const keyOfItem = (it: Item) => (it.kind === "group" ? `g:${it.name}` : it.kind === "session" ? `s:${it.row.name}` : "");

const snap = () => snapshot(liveSessions());
const home = (p: string) => {
  const h = process.env.HOME;
  return h && (p === h || p.startsWith(h + "/")) ? "~" + p.slice(h.length) : p;
};

function useTick<T>(read: () => T, ms = 1000): [T, () => void] {
  const [v, setV] = useState(read);
  useEffect(() => {
    const t = setInterval(() => setV(read()), ms);
    return () => clearInterval(t);
  }, []);
  return [v, () => setV(read())];
}

function useSize() {
  const stdout = useStdout().stdout as NodeJS.WriteStream;
  const get = () => ({ cols: stdout.columns ?? 100, rows: stdout.rows ?? 30 });
  const [size, setSize] = useState(get);
  useEffect(() => {
    const onResize = () => setSize(get());
    stdout.on("resize", onResize);
    return () => void stdout.off("resize", onResize);
  }, []);
  return size;
}

// Survive attach/detach, which re-renders the app.
let remembered: string | undefined;

function App({ onAction }: { onAction: (a: Action) => void }) {
  const { exit } = useApp();
  const { cols, rows: termRows } = useSize();
  const [rows, refreshRows] = useTick<Row[]>(snap);
  const [groups, refreshGroups] = useTick<Record<string, Group>>(readGroups);
  const refresh = () => { refreshRows(); refreshGroups(); };
  // The selected list line: "s:<session>" or "g:<group>".
  const [selKey, setSelKey] = useState<string | undefined>(remembered);
  useEffect(() => { remembered = selKey; }, [selKey]);
  // Folded groups are saved, so the dashboard reopens the way it was left.
  const [folded, setFolded] = useState(readFolded);
  const toggleFold = (g: string) => setFolded((f) => {
    const n = new Set(f);
    if (n.has(g)) n.delete(g); else n.add(g);
    try { writeFolded(n); } catch { /* the fold still works for this run */ }
    return n;
  });
  const [mode, setMode] = useState<Mode>({ kind: "list" });
  const [newAgent, setNewAgent] = useState<Agent>("claude");
  // The Claude Code account a new session runs under; null is the default login.
  const [newAccount, setNewAccount] = useState<string | null>(null);
  const [accountNames] = useTick(() => Object.keys(readAccounts()).sort());
  const [input, setInput] = useState("");
  const [msg, setMsg] = useState("");
  // Ink keeps the raw key sequences on an internal emitter; key passthrough forwards them byte for byte.
  const keyEvents = (useStdin() as ReturnType<typeof useStdin> & { internal_eventEmitter?: EventEmitter })
    .internal_eventEmitter;

  const groupNames = Object.keys(groups).sort((a, b) => a.localeCompare(b));
  const items: Item[] = [];
  for (const g of groupNames) {
    const members = rows.filter((r) => r.group === g);
    items.push({ kind: "group", name: g, count: members.length, folded: folded.has(g) });
    if (!folded.has(g)) items.push(...members.map((row) => ({ kind: "session", row, indent: true }) as const));
  }
  const loose = rows.filter((r) => !r.group || !groups[r.group]);
  if (groupNames.length && loose.length) items.push({ kind: "label", text: "no group" });
  items.push(...loose.map((row) => ({ kind: "session", row, indent: false }) as const));
  const pickable = items.map((it, i) => (it.kind === "label" ? -1 : i)).filter((i) => i >= 0);

  const found = items.findIndex((it) => it.kind !== "label" && keyOfItem(it) === selKey);
  const idx = found >= 0 ? found : (pickable[0] ?? -1);
  const cur = items[idx];
  const sel = cur?.kind === "session" ? cur.row : undefined;
  const selGroup = cur?.kind === "group" ? cur.name : undefined;
  /** The group new sessions go to: the selected group, or the selected session's. */
  const ctxGroup = selGroup ?? (sel?.group && groups[sel.group] ? sel.group : null);
  const setSelName = (name: string) => setSelKey(`s:${name}`);
  const [shown, setShown] = useState("");
  const previewName = sel?.live ? sel.name : undefined;
  // The preview shows its screen, so the reply is no longer news.
  useEffect(() => { if (sel?.unread) { markSeen(sel.name); refreshRows(); } }, [sel?.name, sel?.unread]);
  useEffect(() => {
    const read = () => setShown(previewName ? capturePane(previewName) : "");
    read();
    const t = setInterval(read, mode.kind === "keys" ? 150 : 1000); // typing wants a live preview
    return () => clearInterval(t);
  }, [previewName, mode.kind]);

  const counts = ([["working", COLOR.working], ["waiting", COLOR.waiting], ["unread", UNREAD], ["idle", COLOR.idle]] as const)
    .map(([s, c]) => [s, c, rows.filter((r) => stateOf(r) === s).length] as const)
    .filter(([, , n]) => n > 0);

  const toList = (message = "") => { setMode({ kind: "list" }); setInput(""); setMsg(message); };

  // Key passthrough: every key goes to the session, as if attached, while the dashboard stays on screen.
  // Ctrl-b d stops (as it detaches an attach); Ctrl-b Ctrl-b sends a literal Ctrl-b.
  const keysTo = mode.kind === "keys" ? mode.name : undefined;
  useEffect(() => {
    if (!keysTo) return;
    if (!keyEvents) return toList("key passthrough is not supported by this Ink version");
    let closed = false;
    let channel: { write: (d: string) => void; paste: (d: string) => void; close: () => void } | undefined;
    const queued: string[] = [];
    void openInput(keysTo).then((r) => {
      if (!r.ok) return closed || toList(r.error);
      if (closed) return r.close();
      channel = r;
      for (const d of queued.splice(0)) r.write(d);
    });
    const write = (d: string) => { if (d) (channel ? channel.write(d) : queued.push(d)); };
    const filter = createPrefixFilter();
    const onInput = (data: string) => {
      const { out, detach } = filter(data);
      write(out);
      if (detach) toList(`stopped sending keys to '${keysTo}'`);
    };
    // Pasted text and dropped files arrive whole, and go in as a paste (not as typed keys, where a newline submits).
    const onPaste = (text: string) => { if (channel) channel.paste(text); else queued.push(`\x1b[200~${text}\x1b[201~`); };
    keyEvents.on("input", onInput);
    keyEvents.on("paste", onPaste);
    return () => { closed = true; keyEvents.off("input", onInput); keyEvents.off("paste", onPaste); channel?.close(); };
  }, [keysTo]);
  useEffect(() => {
    if (keysTo && !rows.find((r) => r.name === keysTo)?.live) toList(`'${keysTo}' stopped`);
  }, [keysTo, rows]);

  const move = (d: number) => {
    if (pickable.length === 0) return;
    const at = Math.max(0, pickable.indexOf(idx));
    const next = items[pickable[(at + d + pickable.length) % pickable.length] as number];
    if (next) setSelKey(keyOfItem(next));
  };
  const moveTargets: Array<string | null> = [null, ...groupNames];
  const newSession = (then: "dir" | "id") => {
    setMsg("");
    setNewAgent((ctxGroup && groups[ctxGroup]?.agent) || "claude");
    setNewAccount((ctxGroup && groups[ctxGroup]?.account) || null);
    setMode({ kind: "new-name", then, group: ctxGroup });
  };

  // A paste or a file dropped on the window: into the prompt being typed, or straight into the selected session
  // (as it would be if attached), so you can drop a file and then press i or Enter to go on typing.
  // Bracketed paste is on while this is active, which is how a whole drop is told apart from typing.
  usePaste((text) => {
    if (mode.kind === "send" || mode.kind === "new-name" || mode.kind === "new-id" || mode.kind === "group-name") {
      return setInput((v) => v + (mode.kind === "send" ? text : text.replace(/\s+/g, "")));
    }
    if (mode.kind !== "list" || !sel) return; // in "keys" mode the passthrough forwards it
    if (!sel.live) return setMsg(`'${sel.name}' is not running - nothing pasted`);
    const name = sel.name;
    void pasteInto(name, text).then((r) => setMsg(r.ok ? `pasted into '${name}' - i to keep typing, Enter to attach` : r.error));
  }, { isActive: mode.kind === "keys" || mode.kind === "list" || mode.kind === "send" || mode.kind === "new-name" || mode.kind === "new-id" || mode.kind === "group-name" });

  useInput((ch, key) => {
    if (mode.kind === "keys") return; // everything goes to the session
    if (key.ctrl && ch === "c") return exit();
    if (mode.kind === "new-dir" || mode.kind === "group-dir") return; // the folder picker has the keyboard
    if (mode.kind === "list") {
      if (ch === "q") return exit();
      if (key.upArrow || ch === "k") return move(-1);
      if (key.downArrow || ch === "j") return move(1);
      if (key.return && selGroup) return toggleFold(selGroup);
      if (key.return && sel) {
        if (!sel.live) return setMsg(`'${sel.name}' is not running`);
        onAction({ attach: sel.name });
        return exit();
      }
      if (ch === "n") return newSession("dir");
      if (ch === "u") return newSession("id");
      if (ch === "g") { setMsg(""); setNewAgent("claude"); return setMode({ kind: "group-name" }); }
      if (ch === "e" && ctxGroup) {
        setMsg(""); setNewAgent(groups[ctxGroup]?.agent ?? "claude");
        return setMode({ kind: "group-dir", name: ctxGroup });
      }
      if (ch === "m" && sel) {
        if (!groupNames.length) return setMsg("no groups yet - press g to create one");
        setMsg(""); return setMode({ kind: "move", name: sel.name, to: Math.max(0, moveTargets.indexOf(sel.group)) });
      }
      if (ch === "d" && selGroup) {
        const g = selGroup;
        return setMode({
          kind: "confirm", question: `Delete group '${g}'? Its sessions stay, without a group.`,
          run: () => { const r = removeGroup(g); toList(r.ok ? `deleted group '${g}'` : r.error); refresh(); },
        });
      }
      if (ch === "i" && sel) {
        if (!sel.live) return setMsg(`'${sel.name}' is not running`);
        setMsg(""); return setMode({ kind: "keys", name: sel.name });
      }
      if (ch === "," && sel) { // tmux's rename key
        setMsg(""); setInput(sel.name); return setMode({ kind: "rename", name: sel.name });
      }
      if (ch === "s" && sel) {
        if (!sel.live) return setMsg(`'${sel.name}' is not running`);
        setMsg(""); return setMode({ kind: "send", name: sel.name });
      }
      if (ch === "x" && sel?.live) {
        const name = sel.name;
        return setMode({
          kind: "confirm", question: `Kill '${name}'?`,
          run: async () => { const r = await killSession(name); toList(r.ok ? `killed '${name}'` : r.error); refresh(); },
        });
      }
      if (ch === "r" && sel) {
        if (sel.live) return setMsg(`'${sel.name}' is already running`);
        if (!sel.resumable) return setMsg(`'${sel.name}' has no saved record`);
        const name = sel.name;
        setMsg(`resuming '${name}'...`);
        void resumeSession(name).then((r) => {
          setMsg(r.ok ? `resumed '${name}'${r.resumed ? "" : " (fresh: no conversation recorded)"} - Enter to attach` : r.error);
          refresh();
        });
        return;
      }
      if (ch === "d" && sel) {
        const { name, live } = sel;
        return setMode({
          kind: "confirm", question: live ? `Kill and delete '${name}'?` : `Delete '${name}' and its saved record?`,
          run: async () => {
            const k = live ? await killSession(name) : { ok: true as const };
            const r = k.ok ? forgetSession(name) : k;
            toList(r.ok ? `deleted '${name}'` : r.error); refresh();
          },
        });
      }
      if (ch === "c") {
        const stale = cleanStale(); refresh();
        return setMsg(`removed ${stale.length} stale entr${stale.length === 1 ? "y" : "ies"}`);
      }
    } else if (mode.kind === "confirm") {
      if (ch === "y") void mode.run();
      else if (ch === "n" || key.escape) toList("cancelled");
    } else if (mode.kind === "group-notify") {
      if (ch !== "y" && ch !== "n") return key.escape ? toList("cancelled") : undefined;
      const r = setGroup(mode.name, { dir: mode.dir, notify: ch === "y", agent: newAgent });
      if (r.ok) setSelKey(`g:${mode.name}`);
      toList(r.ok ? `saved group '${mode.name}' - new sessions in it start in ${home(mode.dir)}` : r.error);
      refresh();
    } else if (mode.kind === "move") {
      const n = moveTargets.length;
      if (key.upArrow || key.leftArrow) return setMode({ ...mode, to: (mode.to - 1 + n) % n });
      if (key.downArrow || key.rightArrow || key.tab) return setMode({ ...mode, to: (mode.to + 1) % n });
      if (key.escape) return toList("cancelled");
      if (key.return) {
        const to = moveTargets[mode.to] ?? null;
        const r = moveSession(mode.name, to);
        toList(r.ok ? (to ? `moved '${mode.name}' to '${to}'` : `took '${mode.name}' out of its group`) : r.error);
        refresh();
      }
    } else {
      if (key.tab && (mode.kind === "new-name" || mode.kind === "new-id")) {
        setNewAgent((a) => (a === "claude" ? "agy" : "claude"));
      } else if ((key.upArrow || key.downArrow) && (mode.kind === "new-name" || mode.kind === "new-id") && accountNames.length) {
        const choices = [null, ...accountNames];
        const at = Math.max(0, choices.indexOf(newAccount));
        setNewAccount(choices[(at + (key.upArrow ? -1 : 1) + choices.length) % choices.length] ?? null);
      } else if (key.escape) {
        toList("cancelled");
      }
    }
  });

  const start = async (name: string, group: string | null, dir: string | undefined, sessionId?: string) => {
    setMsg(`starting '${name}' (${newAgent})...`);
    const notify = (group ? groups[group]?.notify : undefined) ?? true;
    const account = newAgent === "claude" ? newAccount ?? "" : ""; // "" picks the default login over the group's
    const r = await createSession(name, dir, { notify, agent: newAgent, sessionId, group: group ?? undefined, account });
    if (r.ok) setSelName(name);
    toList(r.ok ? `started '${name}' (${newAgent}) - Enter to attach` : r.error);
    refresh();
  };

  const submit = async (value: string) => {
    const v = value.trim();
    if (mode.kind === "new-name") {
      if (!validName(v)) return setMsg("name: letters, digits, - and _ only");
      setInput(""); setMsg("");
      const { group } = mode;
      return setMode(mode.then === "id" ? { kind: "new-id", name: v, group } : { kind: "new-dir", name: v, group });
    }
    if (mode.kind === "new-id") {
      if (!v) return setMsg("paste the session id");
      return start(mode.name, mode.group, undefined, v);
    }
    if (mode.kind === "group-name") {
      if (!validName(v)) return setMsg("group name: letters, digits, - and _ only");
      if (groups[v]) return setMsg(`group '${v}' already exists - select it and press e to edit it`);
      setInput(""); setMsg("");
      return setMode({ kind: "group-dir", name: v });
    }
    if (mode.kind === "rename") {
      if (!v || v === mode.name) return toList();
      const from = mode.name;
      const r = await renameSession(from, v);
      if (r.ok) setSelName(v);
      toList(r.ok ? `renamed '${from}' to '${v}'` : r.error);
      return refresh();
    }
    if (mode.kind === "send") {
      if (!v) return toList();
      const row = rows.find((r) => r.name === mode.name);
      const go = async () => { const r = await sendPrompt(mode.name, v); toList(r.ok ? `sent to '${mode.name}'` : r.error); };
      if (row && (row.state === "working" || row.state === "waiting")) {
        return setMode({ kind: "confirm", question: `'${mode.name}' is ${row.state}. Send anyway?`, run: go });
      }
      return go();
    }
  };

  const accountTag = newAgent === "claude" && accountNames.length ? ` (account: ${newAccount ?? "default"})` : "";
  const accountKeys = newAgent === "claude" && accountNames.length ? ", ↑↓: account" : "";
  const leftW = Math.min(48, Math.max(30, Math.floor(cols * 0.38)));
  const bodyH = termRows - 4; // header + footer(2) + slack so Ink never fills the whole screen
  const previewLines = Math.max(1, bodyH - 4);
  const lines = shown.split("\n");
  while (lines.length && !lines[lines.length - 1]?.trim()) lines.pop();
  const tail = lines.slice(-previewLines);
  // Keep the selected line inside the visible part of the list.
  const listH = Math.max(1, bodyH - 2);
  const top = Math.max(0, Math.min(idx - Math.floor(listH / 2), items.length - listH));
  const pickerGroup = mode.kind === "new-dir" && mode.group ? groups[mode.group] : undefined;
  const editing = mode.kind === "group-dir" ? groups[mode.name] : undefined;
  const info = selGroup ? groups[selGroup] : undefined;

  return (
    <Box flexDirection="column" height={termRows - 1}>
      <Box>
        <Text bold color="cyan">clamux</Text>
        <Text dimColor>  {rows.length} session{rows.length === 1 ? "" : "s"}</Text>
        {counts.map(([s, c, n]) => (
          <Text key={s} color={c}>  {n} {s}</Text>
        ))}
      </Box>

      <Box height={bodyH}>
        <Box flexDirection="column" width={leftW} flexShrink={0} borderStyle="round" borderColor="gray" paddingX={1}>
          {items.length === 0 && <Text dimColor>No sessions. Press n to create one, g for a group.</Text>}
          {items.slice(top, top + listH).map((it, i) => {
            const on = top + i === idx;
            if (it.kind === "label") return <Text key="label" dimColor>  ─ {it.text} ─</Text>;
            if (it.kind === "group") {
              return (
                <Box key={`g:${it.name}`}>
                  <Text color="blue" bold={on} inverse={on}>{it.folded ? "▸" : "▾"} {it.name}</Text>
                  <Text dimColor> ({it.count})</Text>
                </Box>
              );
            }
            const r = it.row;
            return (
              <Box key={r.name}>
                <Text color={colorOf(r)}>{it.indent ? "  " : ""}{on ? "▸" : " "}● </Text>
                <Box flexGrow={1} flexShrink={1} marginRight={1}>
                  <Text bold={on || r.unread} wrap="truncate-end">{r.name}</Text>
                </Box>
                <Box width={9} flexShrink={0}><Text color={colorOf(r)} bold={r.unread}>{stateOf(r)}</Text></Box>
                <Box width={6} flexShrink={0} justifyContent="flex-end"><Text dimColor>{fmtAge(r.ageS)}</Text></Box>
              </Box>
            );
          })}
        </Box>

        <Box flexDirection="column" flexGrow={1} flexShrink={1} width={0} borderStyle="round"
          borderColor={mode.kind === "keys" ? "magenta" : mode.kind === "new-dir" || mode.kind === "group-dir" ? "cyan" : "gray"}
          paddingX={1}>
          {mode.kind === "new-dir" ? (
            <>
              <Text wrap="truncate-end">
                <Text bold color="cyan">folder for '{mode.name}'</Text>
                {mode.group ? <Text color="blue">  in {mode.group}</Text> : null}
                {newAccount && newAgent === "claude" ? <Text color="magenta">  as {newAccount}</Text> : null}
                <Text dimColor>  [{newAgent}, Tab: switch]</Text>
              </Text>
              <DirPicker
                key={`new:${mode.name}`}
                start={pickerGroup?.dir ?? process.cwd()} height={bodyH - 3} active
                onPick={(dir) => void start(mode.name, mode.group, dir)}
                onCancel={() => toList("cancelled")}
                onTab={() => setNewAgent((a) => (a === "claude" ? "agy" : "claude"))}
              />
            </>
          ) : mode.kind === "group-dir" ? (
            <>
              <Text wrap="truncate-end">
                <Text bold color="cyan">default folder for group '{mode.name}'</Text>
                <Text dimColor>  [{newAgent}, Tab: switch]</Text>
              </Text>
              <DirPicker
                key={`group:${mode.name}`}
                start={editing?.dir ?? process.cwd()} height={bodyH - 3} active
                onPick={(dir) => { setMode({ kind: "group-notify", name: mode.name, dir }); }}
                onCancel={() => toList("cancelled")}
                onTab={() => setNewAgent((a) => (a === "claude" ? "agy" : "claude"))}
              />
            </>
          ) : selGroup ? (
            <>
              <Text wrap="truncate-end"><Text bold color="blue">group {selGroup}</Text></Text>
              <Text wrap="truncate-end"><Text dimColor>folder   </Text>{info?.dir ? home(info.dir) : "(current directory)"}</Text>
              <Text><Text dimColor>notify   </Text>{info?.notify === false ? "off" : "on"}</Text>
              <Text><Text dimColor>agent    </Text>{info?.agent ?? "claude"}</Text>
              {info?.account ? <Text><Text dimColor>account  </Text><Text color="magenta">{info.account}</Text></Text> : null}
              {info?.args?.length ? <Text wrap="truncate-end"><Text dimColor>args     </Text>{info.args.join(" ")}</Text> : null}
              <Text> </Text>
              <Text dimColor>sessions</Text>
              {rows.filter((r) => r.group === selGroup).map((r) => (
                <Text key={r.name} wrap="truncate-end">
                  <Text color={colorOf(r)}>● </Text>{r.name}<Text dimColor>  {stateOf(r)}</Text>
                </Text>
              ))}
              {!rows.some((r) => r.group === selGroup) && <Text dimColor>none yet - press n to start one here</Text>}
            </>
          ) : sel ? (
            <>
              <Text wrap="truncate-end">
                <Text bold>{sel.name}</Text>
                {sel.group ? <Text color="blue">  {sel.group}</Text> : null}
                <Text dimColor>  [{sel.agent}]</Text>
                {sel.account ? <Text color="magenta">  {sel.account}</Text> : null}
                <Text color={COLOR[sel.state]}>  {sel.state}</Text>
                {sel.detail ? <Text dimColor>  {sel.detail}</Text> : null}
                <Text dimColor>  {home(sel.cwd)}</Text>
              </Text>
              {sel.live ? (
                tail.map((l, i) => <Text key={i} wrap="truncate-end">{l || " "}</Text>)
              ) : (
                <Text dimColor>{sel.resumable ? "session is not running - press r to resume it" : "session is not running"}</Text>
              )}
            </>
          ) : (
            <Text dimColor>nothing selected</Text>
          )}
        </Box>
      </Box>

      <Box flexDirection="column">
        {mode.kind === "list" && (
          <Text dimColor wrap="truncate-end">
            {selGroup
              ? "↑↓ select  ⏎ fold  n new session here  u new from id  e edit group  d delete group  g new group  q quit"
              : "↑↓ select  ⏎ attach (Ctrl-b d: back)  i keys  n new  u new from id  r resume  s send  , rename  x kill  d delete  m move to group  g new group  c clean  q quit"}
          </Text>
        )}
        {mode.kind === "group-dir" && (
          <Text dimColor wrap="truncate-end">
            pick the folder new sessions in '{mode.name}' start in:  ↑↓ move  ⏎/→ open  ⏎ on ✓ use it  ←/⌫ parent  Tab agent  Esc cancel
          </Text>
        )}
        {mode.kind === "group-notify" && (
          <Text color="cyan">notify when sessions in '{mode.name}' finish or need input? (y/n)</Text>
        )}
        {mode.kind === "move" && (
          <Text wrap="truncate-end">
            <Text color="cyan">move '{mode.name}' to: </Text>
            {moveTargets.map((g, i) => (
              <Text key={g ?? ""} inverse={i === mode.to} color={g ? "blue" : undefined}> {g ?? "(no group)"} </Text>
            ))}
            <Text dimColor>  ←→ choose  ⏎ move  Esc cancel</Text>
          </Text>
        )}
        {mode.kind === "keys" && (
          <Text color="magenta" bold>
            sending every key to '{mode.name}'  ·  Ctrl-b d: back to the dashboard  ·  Ctrl-b Ctrl-b: a literal Ctrl-b
          </Text>
        )}
        {mode.kind === "new-dir" && (
          <Text dimColor wrap="truncate-end">
            ↑↓ move  ⏎/→ open  ⏎ on ✓ use it  ←/⌫ parent  type to filter  Tab agent  Esc cancel
          </Text>
        )}
        {(mode.kind === "new-name" || mode.kind === "new-id" || mode.kind === "send" || mode.kind === "group-name" || mode.kind === "rename") && (
          <Box>
            <Text color="cyan">
              {mode.kind === "group-name"
                ? "new group name: "
                : mode.kind === "rename"
                  ? `rename '${mode.name}' to: `
                : mode.kind === "new-name"
                  ? `new ${newAgent} session${mode.group ? ` in '${mode.group}'` : ""}${accountTag}${mode.then === "id" ? ", continuing a conversation" : ""} - name (Tab: agent${accountKeys}): `
                  : mode.kind === "new-id"
                    ? `${newAgent === "agy" ? "agy conversation id" : "Claude session id (UUID)"} for '${mode.name}'${accountTag} (Tab: agent${accountKeys}): `
                    : `prompt for '${mode.name}': `}
            </Text>
            <TextInput value={input} onChange={setInput} onSubmit={submit} />
          </Box>
        )}
        {mode.kind === "confirm" && <Text color="yellow">{mode.question} (y/n)</Text>}
        <Text color="yellow">{msg || " "}</Text>
      </Box>
    </Box>
  );
}

const ALT_ON = "\x1b[?1049h";
const ALT_OFF = "\x1b[?1049l";

export async function runTui(): Promise<void> {
  for (;;) {
    let action: Action | undefined;
    process.stdout.write(ALT_ON);
    try {
      // Ctrl-c is handled by the app, so key passthrough can send it to the session.
      const app = render(<App onAction={(a) => { action = a; }} />, { exitOnCtrlC: false });
      await app.waitUntilExit();
    } finally {
      process.stdout.write(ALT_OFF);
    }
    if (!action) return;
    await attachSession((action as Action).attach);
  }
}
