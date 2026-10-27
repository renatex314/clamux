import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { childEnv } from "./env.js";
import { selfPath } from "./paths.js";
import { SKILL_MD } from "./skill.js";

const SERVER = "clamux";
const win = process.platform === "win32";

const claudeDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
const skillFile = () => path.join(claudeDir(), "skills", SERVER, "SKILL.md");

function claude(args: string[]): { ok: boolean; out: string } {
  const r = spawnSync("claude", args, { encoding: "utf8", env: childEnv(), shell: win, stdio: ["ignore", "pipe", "pipe"] });
  if (r.error) return { ok: false, out: (r.error as NodeJS.ErrnoException).code === "ENOENT" ? "the `claude` command was not found on PATH" : r.error.message };
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

function onPath(cmd: string): boolean {
  const exts = win ? ["", ...(process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";")] : [""];
  const dirs = (process.env.PATH ?? process.env.Path ?? "").split(path.delimiter).filter(Boolean);
  return dirs.some((d) => exts.some((e) => {
    try {
      return fs.statSync(path.join(d, cmd + e)).isFile();
    } catch {
      return false;
    }
  }));
}

/** `clamux` if it resolves on PATH (a global install), otherwise this exact install by absolute path. */
function serverCommand(): string[] {
  return onPath(SERVER) ? [SERVER, "mcp"] : [process.execPath, selfPath(), "mcp"];
}

/** Registers the MCP server for every project and installs the skill that explains how to use it. */
export function setup(): { ok: boolean; lines: string[] } {
  const lines: string[] = [];
  let ok = true;

  claude(["mcp", "remove", SERVER, "--scope", "user"]); // replace any earlier registration; "not found" is fine
  const cmd = serverCommand();
  const added = claude(["mcp", "add", "--scope", "user", SERVER, "--", ...cmd]);
  if (added.ok) {
    lines.push(`registered the MCP server for all projects: ${cmd.join(" ")}`);
  } else {
    ok = false;
    lines.push(`could not register the MCP server: ${added.out}`);
    lines.push(`  register it yourself: claude mcp add --scope user ${SERVER} -- ${cmd.join(" ")}`);
  }

  fs.mkdirSync(path.dirname(skillFile()), { recursive: true });
  fs.writeFileSync(skillFile(), SKILL_MD);
  lines.push(`installed the usage skill: ${skillFile()}`);

  if (ok) lines.push("restart Claude Code (or run /mcp) to pick it up.");
  return { ok, lines };
}

/** Undoes `setup`. */
export function unsetup(): { ok: boolean; lines: string[] } {
  const lines: string[] = [];
  const removed = claude(["mcp", "remove", SERVER, "--scope", "user"]);
  lines.push(removed.ok ? "removed the MCP server registration" : `MCP server: ${removed.out || "nothing to remove"}`);
  const dir = path.dirname(skillFile());
  const had = fs.existsSync(dir);
  fs.rmSync(dir, { recursive: true, force: true });
  lines.push(had ? `removed the skill: ${dir}` : "skill: nothing to remove");
  return { ok: true, lines };
}
