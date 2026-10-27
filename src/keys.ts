const NAMED: Record<string, string> = {
  Enter: "\r", Escape: "\x1b", Esc: "\x1b", Tab: "\t", BTab: "\x1b[Z", Space: " ",
  BSpace: "\x7f", Backspace: "\x7f", Delete: "\x1b[3~",
  Up: "\x1b[A", Down: "\x1b[B", Right: "\x1b[C", Left: "\x1b[D",
  Home: "\x1b[H", End: "\x1b[F", PageUp: "\x1b[5~", PageDown: "\x1b[6~",
};

/** Translates a key name ("Enter", "Down", "C-c") to the bytes a terminal would send; anything else is typed literally. */
export function keyToBytes(key: string): string {
  const named = NAMED[key];
  if (named !== undefined) return named;
  const ctrl = /^C-(.)$/i.exec(key);
  if (ctrl?.[1]) return String.fromCharCode(ctrl[1].toUpperCase().charCodeAt(0) & 0x1f);
  return key;
}
