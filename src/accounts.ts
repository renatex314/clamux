import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HOME_DIR } from "./paths.js";

/**
 * A Claude Code account is a Claude Code config directory (`CLAUDE_CONFIG_DIR`): it holds that account's login,
 * `.claude.json` and conversations. Sessions without an account use the default one (`~/.claude`).
 */
export interface Account {
  dir: string;
}

const ACCOUNTS = path.join(HOME_DIR, "accounts.json");

/** Where `clamux account add` puts a new account's config directory. */
export const newAccountDir = (name: string) => path.join(HOME_DIR, "accounts", name);

export function readAccounts(): Record<string, Account> {
  try {
    const v = JSON.parse(fs.readFileSync(ACCOUNTS, "utf8")) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, Account>) : {};
  } catch {
    return {};
  }
}

export function writeAccounts(accounts: Record<string, Account>): void {
  fs.mkdirSync(HOME_DIR, { recursive: true });
  const tmp = `${ACCOUNTS}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(accounts, null, 2));
  fs.renameSync(tmp, ACCOUNTS);
}

/** The config directory Claude Code uses when no account is chosen. */
export const defaultClaudeDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");

/** Claude Code's global state file for a config directory (`~/.claude.json` for the default one). */
function stateFile(dir: string | null): string {
  if (dir) return path.join(dir, ".claude.json");
  return process.env.CLAUDE_CONFIG_DIR ? path.join(process.env.CLAUDE_CONFIG_DIR, ".claude.json") : path.join(os.homedir(), ".claude.json");
}

function readState(dir: string | null): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(stateFile(dir), "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** The email the account is logged in with, as Claude Code recorded it; null if it never logged in. */
export function accountEmail(dir: string | null): string | null {
  const acct = readState(dir)?.oauthAccount as { emailAddress?: unknown } | undefined;
  return typeof acct?.emailAddress === "string" ? acct.emailAddress : null;
}

/** What a new account shares with the default one: settings and customizations, never the login or history. */
const SHARED = ["settings.json", "CLAUDE.md", "keybindings.json", "skills", "agents", "commands", "output-styles", "plugins"];

/**
 * Links the default account's settings, CLAUDE.md, skills, agents, commands and plugins into `dir`, and copies its
 * user-scope MCP servers, so a new account works like the default one. Returns what was shared.
 */
export function shareDefaults(dir: string): string[] {
  const from = defaultClaudeDir();
  const shared: string[] = [];
  for (const item of SHARED) {
    const src = path.join(from, item);
    const dst = path.join(dir, item);
    if (!fs.existsSync(src) || fs.existsSync(dst)) continue;
    try {
      // Directories as junctions on Windows, which need no special privileges.
      fs.symlinkSync(src, dst, fs.statSync(src).isDirectory() ? "junction" : "file");
      shared.push(item);
    } catch {
      // Windows without Developer Mode cannot link files; copy those instead.
      if (fs.statSync(src).isFile()) {
        fs.copyFileSync(src, dst);
        shared.push(item);
      }
    }
  }
  const mcpServers = readState(null)?.mcpServers;
  if (mcpServers && typeof mcpServers === "object" && Object.keys(mcpServers).length && !fs.existsSync(stateFile(dir))) {
    fs.writeFileSync(stateFile(dir), JSON.stringify({ mcpServers }, null, 2));
    shared.push("MCP servers");
  }
  return shared;
}
