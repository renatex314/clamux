import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const HOME_DIR = path.join(os.homedir(), ".clamux");
export const STATUS_DIR = path.join(HOME_DIR, "status");
/** Per-session runtime files owned by the session host: registry, config, screen, log. */
export const RUN_DIR = path.join(HOME_DIR, "run");
/** One record per session that can be resumed after its host process is gone. */
export const SAVED_DIR = path.join(HOME_DIR, "saved");
export const SETTINGS = path.join(HOME_DIR, "settings.json");

export const registryFile = (name: string) => path.join(RUN_DIR, `${name}.json`);
export const configFile = (name: string) => path.join(RUN_DIR, `${name}.cfg`);
export const screenFile = (name: string) => path.join(RUN_DIR, `${name}.screen`);
export const errorFile = (name: string) => path.join(RUN_DIR, `${name}.err`);

/** Where a session host listens: a named pipe on Windows, a unix socket elsewhere. */
export function endpointFor(name: string): string {
  const id = crypto.createHash("sha1").update(HOME_DIR).digest("hex").slice(0, 8);
  if (process.platform === "win32") return `\\\\.\\pipe\\clamux-${id}-${name}`;
  const p = path.join(RUN_DIR, `${name}.sock`);
  // sun_path is limited to ~104 bytes; fall back to a short path when the home directory is deep.
  return p.length <= 96 ? p : path.join("/tmp", `clamux-${id}-${name}.sock`);
}

/**
 * Absolute path of clamux's own CLI entry, used to build the hook command and to start session
 * hosts. Resolved relative to this module (all bundles sit side by side in dist/), never from
 * process.argv - when clamux is used as an SDK, argv[1] is the caller's script.
 */
export function selfPath(): string {
  return fileURLToPath(new URL("./cli.js", import.meta.url));
}
