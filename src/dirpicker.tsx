import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";

type Item = { kind: "pick" } | { kind: "up" } | { kind: "dir"; name: string };

const home = (p: string) => {
  const h = os.homedir();
  return p === h || p.startsWith(h + path.sep) ? "~" + p.slice(h.length) : p;
};
const expand = (p: string) => (p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p);
const isDir = (p: string) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** Subdirectories of `dir`, sorted; symlinks count when they point at a directory. */
function subdirs(dir: string): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() || (e.isSymbolicLink() && isDir(path.join(dir, e.name))))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  } catch {
    return [];
  }
}

/**
 * A folder browser for picking the directory a new session runs in. Typing filters the list (hidden folders
 * only show up while filtering); a filter that starts with "/" or "~" is a path to jump to with Enter.
 */
export function DirPicker({ start, height, active, onPick, onCancel, onTab }: {
  start: string;
  height: number;
  active: boolean;
  onPick: (dir: string) => void;
  onCancel: () => void;
  onTab: () => void;
}) {
  const [cwd, setCwd] = useState(() => (isDir(start) ? path.resolve(start) : os.homedir()));
  const [filter, setFilter] = useState("");
  const [sel, setSel] = useState(0);
  const [err, setErr] = useState("");

  const all = useMemo(() => subdirs(cwd), [cwd]);
  const isPath = /^[~/\\]|^[A-Za-z]:[\\/]/.test(filter);
  const items: Item[] = useMemo(() => {
    const f = filter.toLowerCase();
    const dirs = isPath ? [] : all.filter((n) => (f ? n.toLowerCase().includes(f) : !n.startsWith(".")));
    const up = path.dirname(cwd) !== cwd ? [{ kind: "up" } as const] : [];
    return [{ kind: "pick" }, ...up, ...dirs.map((name) => ({ kind: "dir", name }) as const)];
  }, [all, filter, cwd, isPath]);

  const hasUp = path.dirname(cwd) !== cwd;
  const hasDirs = items.length > (hasUp ? 2 : 1);
  const go = (dir: string) => { setCwd(dir); setFilter(""); setSel(0); setErr(""); };
  // While filtering, start on the first match so Enter opens it.
  const typed = (f: string) => { setFilter(f); setErr(""); setSel(f ? (hasUp ? 2 : 1) : 0); };
  // A filter with no match leaves only "use this folder" / "..": stay on the former rather than jump to the parent.
  const at = filter && !hasDirs ? 0 : Math.min(sel, items.length - 1);
  const cur = items[at];

  useInput((ch, key) => {
    if (key.tab) return onTab();
    if (key.escape) return filter ? typed("") : onCancel();
    if (key.upArrow) return setSel(Math.max(0, at - 1));
    if (key.downArrow) return setSel(Math.min(items.length - 1, at + 1));
    if (key.pageUp) return setSel(Math.max(0, at - (height - 3)));
    if (key.pageDown) return setSel(Math.min(items.length - 1, at + (height - 3)));
    if (key.leftArrow) return go(path.dirname(cwd));
    if (key.backspace || key.delete) return filter ? typed(filter.slice(0, -1)) : go(path.dirname(cwd));
    if (key.return || key.rightArrow) {
      if (isPath) {
        const target = path.resolve(cwd, expand(filter));
        return isDir(target) ? go(target) : setErr(`not a folder: ${target}`);
      }
      if (!cur) return;
      if (cur.kind === "pick") return key.return ? onPick(cwd) : undefined;
      if (cur.kind === "up") return go(path.dirname(cwd));
      return go(path.join(cwd, cur.name));
    }
    if (ch && !key.ctrl && !key.meta) typed(filter + ch);
  }, { isActive: active });

  // Keep the selection inside the visible window.
  const listH = Math.max(1, height - 3);
  const top = Math.max(0, Math.min(at - Math.floor(listH / 2), items.length - listH));
  const shown = items.slice(top, top + listH);

  return (
    <Box flexDirection="column">
      <Text wrap="truncate-start"><Text bold>{home(cwd)}</Text></Text>
      <Text wrap="truncate-end" color={err ? "red" : "cyan"}>
        {err || (filter ? (isPath ? `go to: ${filter}  (Enter)` : `filter: ${filter}`) : "type to filter · / or ~ to type a path")}
      </Text>
      {shown.map((it, i) => {
        const on = top + i === at;
        const label = it.kind === "pick" ? `✓ use this folder` : it.kind === "up" ? "..  (parent folder)" : `${it.name}/`;
        return (
          <Text key={it.kind === "dir" ? `d:${it.name}` : it.kind} wrap="truncate-end"
            color={it.kind === "pick" ? "green" : undefined} inverse={on} bold={it.kind === "pick"}>
            {on ? "▸ " : "  "}{label}
          </Text>
        );
      })}
      {!hasDirs && !isPath && (
        <Text dimColor>  {filter ? "no folder matches" : "no subfolders"}</Text>
      )}
    </Box>
  );
}
