import fs from "node:fs";
import { idFile } from "./paths.js";

/**
 * The name of the clamux session this process runs inside (an agent, its hooks, its MCP servers, or a command
 * it runs), or undefined outside one. The host sets CLAMUX_ID, which never changes, and keeps the current name
 * under it, so a session renamed while running is still found; CLAMUX_NAME is the name it started with.
 */
export function selfName(): string | undefined {
  const id = process.env.CLAMUX_ID;
  if (id) {
    try {
      const name = fs.readFileSync(idFile(id), "utf8").trim();
      if (name) return name;
    } catch {
      // the host is gone, or predates ids
    }
  }
  return process.env.CLAMUX_NAME || undefined;
}
