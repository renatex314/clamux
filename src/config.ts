import fs from "node:fs";
import path from "node:path";
import { HOME_DIR } from "./paths.js";

/** Settings that apply to every session. */
export interface Config {
  /** Start every Claude Code session with --dangerously-skip-permissions (agy sessions always skip them). */
  skipPermissions?: boolean;
}

const CONFIG = path.join(HOME_DIR, "config.json");

export function readConfig(): Config {
  try {
    const v = JSON.parse(fs.readFileSync(CONFIG, "utf8")) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Config) : {};
  } catch {
    return {};
  }
}

export function writeConfig(fields: Partial<Config>): Config {
  const next = { ...readConfig(), ...fields };
  fs.mkdirSync(HOME_DIR, { recursive: true });
  const tmp = `${CONFIG}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, CONFIG);
  return next;
}
