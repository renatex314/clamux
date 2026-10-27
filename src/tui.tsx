import { useEffect, useState } from "react";
import { Box, Text, render, useApp, useInput, useStdout } from "ink";
import TextInput from "ink-text-input";
import { fmtAge, snapshot, type DisplayState, type Row } from "./status.js";
import { attachSession } from "./attach.js";
import {
  capturePane, cleanStale, createSession, forgetSession, killSession, liveSessions, resumeSession, sendPrompt, validName,
  type Agent,
} from "./sessions.js";

const COLOR: Record<DisplayState, string> = {
  working: "yellow", waiting: "red", idle: "green", starting: "cyan", dead: "red", ended: "gray", "stale?": "magenta",
};

type Mode =
  | { kind: "list" }
  | { kind: "new-name" }
  | { kind: "new-dir"; name: string }
  | { kind: "send"; name: string }
  | { kind: "confirm"; question: string; run: () => void | Promise<void> };

interface Action { attach: string }

const snap = () => snapshot(liveSessions());
const home = (p: string) => p.replace(process.env.HOME ?? "\0", "~");

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

let remembered: string | undefined; // survives attach/detach, which re-renders the app

function App({ onAction }: { onAction: (a: Action) => void }) {
  const { exit } = useApp();
  const { cols, rows: termRows } = useSize();
  const [rows, refresh] = useTick<Row[]>(snap);
  const [selName, setSelName] = useState<string | undefined>(remembered);
  useEffect(() => { remembered = selName; }, [selName]);
  const [mode, setMode] = useState<Mode>({ kind: "list" });
  const [newAgent, setNewAgent] = useState<Agent>("claude");
  const [input, setInput] = useState("");
  const [msg, setMsg] = useState("");

  const idx = Math.max(0, rows.findIndex((r) => r.name === selName));
  const sel = rows[idx];
  const [shown, setShown] = useState("");
  const previewName = sel?.live ? sel.name : undefined;
  useEffect(() => {
    const read = () => setShown(previewName ? capturePane(previewName) : "");
    read();
    const t = setInterval(read, 1000);
    return () => clearInterval(t);
  }, [previewName]);

  const counts = (["working", "waiting", "idle"] as const)
    .map((s) => [s, rows.filter((r) => r.state === s).length] as const)
    .filter(([, n]) => n > 0);

  const toList = (message = "") => { setMode({ kind: "list" }); setInput(""); setMsg(message); };

  const move = (d: number) => {
    if (rows.length === 0) return;
    setSelName(rows[(idx + d + rows.length) % rows.length]?.name);
  };

  useInput((ch, key) => {
    if (mode.kind === "list") {
      if (ch === "q") return exit();
      if (key.upArrow || ch === "k") return move(-1);
      if (key.downArrow || ch === "j") return move(1);
      if (key.return && sel) {
        if (!sel.live) return setMsg(`'${sel.name}' is not running`);
        onAction({ attach: sel.name });
        return exit();
      }
      if (ch === "n") { setMsg(""); return setMode({ kind: "new-name" }); }
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
    } else {
      if (key.tab && (mode.kind === "new-name" || mode.kind === "new-dir")) {
        setNewAgent((a) => (a === "claude" ? "agy" : "claude"));
      } else if (key.escape) {
        toList("cancelled");
      }
    }
  });

  const submit = async (value: string) => {
    const v = value.trim();
    if (mode.kind === "new-name") {
      if (!validName(v)) return setMsg("name: letters, digits, - and _ only");
      setInput(""); setMsg(""); return setMode({ kind: "new-dir", name: v });
    }
    if (mode.kind === "new-dir") {
      setMsg(`starting '${mode.name}' (${newAgent})...`);
      const r = await createSession(mode.name, v || process.cwd(), { notify: true, agent: newAgent });
      if (r.ok) setSelName(mode.name);
      toList(r.ok ? `started '${mode.name}' (${newAgent}) - Enter to attach` : r.error);
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

  const leftW = Math.min(48, Math.max(30, Math.floor(cols * 0.38)));
  const bodyH = termRows - 4; // header + footer(2) + slack so Ink never fills the whole screen
  const previewLines = Math.max(1, bodyH - 4);
  const lines = shown.split("\n");
  while (lines.length && !lines[lines.length - 1]?.trim()) lines.pop();
  const tail = lines.slice(-previewLines);

  return (
    <Box flexDirection="column" height={termRows - 1}>
      <Box>
        <Text bold color="cyan">clamux</Text>
        <Text dimColor>  {rows.length} session{rows.length === 1 ? "" : "s"}</Text>
        {counts.map(([s, n]) => (
          <Text key={s} color={COLOR[s]}>  {n} {s}</Text>
        ))}
      </Box>

      <Box height={bodyH}>
        <Box flexDirection="column" width={leftW} flexShrink={0} borderStyle="round" borderColor="gray" paddingX={1}>
          {rows.length === 0 && <Text dimColor>No sessions. Press n to create one.</Text>}
          {rows.slice(0, bodyH - 2).map((r) => {
            const on = r.name === sel?.name;
            return (
              <Box key={r.name}>
                <Text color={COLOR[r.state]}>{on ? "▸" : " "}● </Text>
                <Box flexGrow={1} flexShrink={1} marginRight={1}>
                  <Text bold={on} wrap="truncate-end">{r.name}</Text>
                </Box>
                <Box width={9} flexShrink={0}><Text color={COLOR[r.state]}>{r.state}</Text></Box>
                <Box width={6} flexShrink={0} justifyContent="flex-end"><Text dimColor>{fmtAge(r.ageS)}</Text></Box>
              </Box>
            );
          })}
        </Box>

        <Box flexDirection="column" flexGrow={1} flexShrink={1} width={0} borderStyle="round" borderColor="gray" paddingX={1}>
          {sel ? (
            <>
              <Text wrap="truncate-end">
                <Text bold>{sel.name}</Text>
                <Text dimColor>  [{sel.agent}]</Text>
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
          <Text dimColor>↑↓ select  ⏎ attach (Ctrl-b d: back)  n new  r resume  s send  x kill  d delete  c clean  q quit</Text>
        )}
        {(mode.kind === "new-name" || mode.kind === "new-dir" || mode.kind === "send") && (
          <Box>
            <Text color="cyan">
              {mode.kind === "new-name"
                ? `new ${newAgent} session name (Tab: switch agent): `
                : mode.kind === "new-dir"
                  ? `directory for '${mode.name}' [${newAgent}, Tab: switch] [${process.cwd()}]: `
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
      const app = render(<App onAction={(a) => { action = a; }} />);
      await app.waitUntilExit();
    } finally {
      process.stdout.write(ALT_OFF);
    }
    if (!action) return;
    await attachSession((action as Action).attach);
  }
}
