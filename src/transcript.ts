import fs from "node:fs";

/** Transcripts grow large (every API request is stored); the answer is always near the end. */
const TAIL_BYTES = 4 * 1024 * 1024;

interface Entry {
  type?: string;
  timestamp?: string;
  created_at?: string;
  isSidechain?: boolean;
  content?: unknown;
  message?: { content?: unknown };
}

function readTail(file: string): string[] {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString("utf8").split("\n");
    if (start > 0) lines.shift(); // begins mid-line
    return lines;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * The text of Claude's final reply in a transcript: the text blocks of the last run of assistant
 * messages (no user message after them). Only entries written at or after `sinceMs` count, so a reply
 * to an earlier prompt is never returned. Returns null if there is none (yet).
 */
export function lastAnswer(file: string, sinceMs = 0): string | null {
  let lines: string[];
  try {
    lines = readTail(file);
  } catch {
    return null;
  }
  const parts: string[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    let e: Entry;
    try {
      e = JSON.parse(lines[i] as string) as Entry;
    } catch {
      continue;
    }
    if (e.type === "PLANNER_RESPONSE" || e.type === "USER_INPUT") {
      if (e.created_at && Date.parse(e.created_at) < sinceMs) break;
      if (e.type === "USER_INPUT") break;
      if (typeof e.content === "string" && e.content) parts.unshift(e.content);
      continue;
    }
    if (e.type !== "assistant" && e.type !== "user") continue; // bookkeeping entries between messages
    if (e.isSidechain) continue; // sub-agent traffic is not the reply
    if (e.timestamp && Date.parse(e.timestamp) < sinceMs) break;
    if (e.type === "user") break; // the prompt, or a tool result: the reply starts after it
    const content = e.message?.content;
    if (Array.isArray(content)) {
      for (const b of content as Array<{ type?: string; text?: string }>) {
        if (b.type === "text" && b.text) parts.unshift(b.text);
      }
    } else if (typeof content === "string" && content) {
      parts.unshift(content);
    }
  }
  return parts.length ? parts.join("\n\n") : null;
}
