import fs from "node:fs";
import { RUN_DIR, configFile, errorFile, registryFile, screenFile } from "./paths.js";

export interface Registry {
  pid: number;
  endpoint: string;
  cwd: string;
  startedAt: number;
}

export function readRegistry(name: string): Registry | null {
  try {
    return JSON.parse(fs.readFileSync(registryFile(name), "utf8")) as Registry;
  } catch {
    return null;
  }
}

export function writeRegistry(name: string, info: Registry): void {
  fs.mkdirSync(RUN_DIR, { recursive: true });
  const tmp = `${registryFile(name)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(info));
  fs.renameSync(tmp, registryFile(name));
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function removeRunFiles(name: string, endpoint?: string): void {
  for (const f of [registryFile(name), configFile(name), screenFile(name), errorFile(name)]) {
    fs.rmSync(f, { force: true });
  }
  if (endpoint && process.platform !== "win32") fs.rmSync(endpoint, { force: true });
}

/** Sessions whose host process is alive. Registrations left by a crashed host are removed. */
export function liveSessions(): Set<string> {
  const live = new Set<string>();
  let files: string[];
  try {
    files = fs.readdirSync(RUN_DIR);
  } catch {
    return live;
  }
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    const name = f.slice(0, -5);
    const info = readRegistry(name);
    if (!info) continue;
    if (pidAlive(info.pid)) live.add(name);
    else removeRunFiles(name, info.endpoint);
  }
  return live;
}
