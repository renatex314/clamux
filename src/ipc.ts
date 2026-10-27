import net from "node:net";

/** Messages are newline-delimited JSON objects, in both directions. */
export interface Msg {
  t: string;
  [key: string]: unknown;
}

export function send(sock: net.Socket, msg: Msg): void {
  if (!sock.destroyed) sock.write(JSON.stringify(msg) + "\n");
}

export function readMessages(sock: net.Socket, onMsg: (m: Msg) => void): void {
  let buf = "";
  sock.setEncoding("utf8");
  sock.on("data", (chunk: string) => {
    buf += chunk;
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line) continue;
      try {
        onMsg(JSON.parse(line) as Msg);
      } catch {
        // ignore malformed frames
      }
    }
  });
}

export function connect(endpoint: string, timeoutMs = 2000): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(endpoint);
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error("timed out connecting to session host"));
    }, timeoutMs);
    sock.once("connect", () => {
      clearTimeout(timer);
      resolve(sock);
    });
    sock.once("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}
