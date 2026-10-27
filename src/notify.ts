import { spawn } from "node:child_process";

const WINDOWS_TOAST = [
  "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null",
  "$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
  "$t = $xml.GetElementsByTagName('text')",
  "$t.Item(0).AppendChild($xml.CreateTextNode($env:CLAMUX_TITLE)) | Out-Null",
  "$t.Item(1).AppendChild($xml.CreateTextNode($env:CLAMUX_MSG)) | Out-Null",
  "$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)",
  // Windows PowerShell's own app id, so the toast is allowed without registering an app.
  "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show($toast)",
].join("; ");

/** Best-effort desktop notification; never throws and never blocks the caller. */
export function notify(title: string, message: string): void {
  try {
    let cmd: string;
    let args: string[];
    const env = { ...process.env, CLAMUX_TITLE: title, CLAMUX_MSG: message };
    if (process.platform === "darwin") {
      cmd = "osascript";
      args = ["-e", `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)} sound name "Glass"`];
    } else if (process.platform === "win32") {
      cmd = "powershell.exe";
      args = ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(WINDOWS_TOAST, "utf16le").toString("base64")];
    } else {
      cmd = "notify-send";
      args = [title, message];
    }
    const child = spawn(cmd, args, { stdio: "ignore", detached: true, windowsHide: true, env });
    child.on("error", () => {}); // e.g. notify-send not installed
    child.unref();
  } catch {
    // notifications are optional
  }
}
