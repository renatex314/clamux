import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { HOME_DIR } from "./paths.js";

const WINDOWS_TOAST = [
  "$ErrorActionPreference = 'Stop'", // fail with a non-zero exit code, so `clamux notify` can tell
  "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null",
  "$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
  "$t = $xml.GetElementsByTagName('text')",
  "$t.Item(0).AppendChild($xml.CreateTextNode($env:CLAMUX_TITLE)) | Out-Null",
  "$t.Item(1).AppendChild($xml.CreateTextNode($env:CLAMUX_MSG)) | Out-Null",
  "$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)",
  // Windows PowerShell's own app id, so the toast is allowed without registering an app.
  "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show($toast)",
].join("; ");

/** Where a failing notifier's error output goes, since notifications themselves are fire-and-forget. */
export const NOTIFY_LOG = path.join(HOME_DIR, "notify.log");

function command(title: string, message: string): { cmd: string; args: string[]; env: NodeJS.ProcessEnv } {
  const env = { ...process.env, CLAMUX_TITLE: title, CLAMUX_MSG: message };
  if (process.platform === "darwin") {
    return {
      cmd: "osascript", env,
      args: ["-e", `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)} sound name "Glass"`],
    };
  }
  if (process.platform === "win32") {
    return {
      cmd: "powershell.exe", env,
      args: ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(WINDOWS_TOAST, "utf16le").toString("base64")],
    };
  }
  return { cmd: "notify-send", args: [title, message], env };
}

/**
 * Best-effort desktop notification; never throws and never blocks the caller. Call it from a process that
 * outlives the notifier (the session host): PowerShell takes a second or more to show a toast on Windows.
 */
export function notify(title: string, message: string): void {
  try {
    const { cmd, args, env } = command(title, message);
    let err: number | "ignore" = "ignore";
    try {
      fs.mkdirSync(HOME_DIR, { recursive: true });
      err = fs.openSync(NOTIFY_LOG, "a");
    } catch {
      // no log, still notify
    }
    const child = spawn(cmd, args, { stdio: ["ignore", "ignore", err], detached: true, windowsHide: true, env });
    if (typeof err === "number") fs.closeSync(err);
    child.on("error", (e) => {
      try {
        fs.appendFileSync(NOTIFY_LOG, `${new Date().toISOString()} ${cmd}: ${e.message}\n`);
      } catch {
        // nowhere to report it
      }
    });
    child.unref();
  } catch {
    // notifications are optional
  }
}

/** Shows a notification and waits for the notifier, for `clamux notify`: reports why it failed, if it did. */
export function notifyTest(title: string, message: string): { ok: boolean; out: string } {
  const { cmd, args, env } = command(title, message);
  const r = spawnSync(cmd, args, { encoding: "utf8", env, windowsHide: true, timeout: 30_000 });
  if (r.error) return { ok: false, out: `${cmd}: ${r.error.message}` };
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}
