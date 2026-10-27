/** The usage skill installed by `clamux setup`: tells Claude Code / Antigravity CLI when and how to use the clamux MCP tools. */
export const SKILL_MD = `---
name: clamux
description: Run and control other Claude Code or Antigravity CLI (agy) sessions in the background through the clamux MCP tools (create_session, ask, send_prompt, wait_for_session, read_screen, press_keys, resume_session). Use it when the user wants work delegated to separate Claude Code or agy/Gemini sessions, tasks run in parallel, a long task run while they keep working, a session checked on or continued later, or names clamux.
---

# Driving Claude Code & Antigravity CLI (agy) sessions with clamux

clamux keeps interactive Claude Code (\`agent: "claude"\`) and Antigravity CLI (\`agent: "agy"\` or \`"gemini"\`) sessions running in the background and exposes them as MCP tools (\`mcp__clamux__*\`). Each session is a full, separate agent CLI instance in a directory you choose. The user can open the same sessions in the \`clamux\` terminal dashboard at any time.

## When to use it

- The user asks to hand work to another Claude or Gemini/agy session, run several tasks in parallel, or keep something running while they do other things.
- The user wants a session checked on, continued, or brought back after a restart.

Do not use it for work you can simply do yourself in this conversation. Each session is a real CLI instance and spends the user's subscription usage, so start one only when separate, long-running or parallel work is the point.

## Workflow

1. \`list_sessions\` first: a session with the right name or directory may already exist (\`live\`), or be \`resumable\`.
2. \`create_session\` with a short \`name\` (letters, digits, \`-\`, \`_\`), the \`dir\` it should work in, and optional \`agent\` (\`"claude"\` by default, or \`"agy"\` / \`"gemini"\`).
3. \`ask\` to send a prompt and get the agent's final reply as text. Reply text only: tool calls and interface are left out.
4. Repeat \`ask\` for follow-ups; the session keeps its conversation.
5. \`kill_session\` when finished. It stays saved, so \`resume_session\` can continue the same conversation later. \`forget_session\` deletes it for good; only do that when the user wants it gone.

## Long tasks and parallel work

\`ask\` blocks until the session answers. For long tasks, or to run several sessions at once, use \`send_prompt\` on each, then \`wait_for_session\` on each (and \`get_answer\` to re-read a reply). If a wait times out the session is simply still working: the result says so, and you wait again. Never send to a session that is \`working\` or \`waiting\`; the call fails with BUSY.

## States and what to do

- \`idle\`: finished, ready for a prompt.
- \`working\`: busy; wait.
- \`waiting\`: stopped for input, usually a permission prompt. Call \`read_screen\` to see exactly what it asks.
- \`starting\`: on its first run in a folder Claude asks whether to trust it. Read the screen first.
- \`ended\` or \`dead\`: not running. If \`resumable\`, \`resume_session\` restarts it with its conversation.

## Prompts that need the user

For permission and folder-trust prompts, show the user what the session is asking (from \`read_screen\`) and let them decide, unless they already told you to approve such things. Answer with \`press_keys\`, for example \`["Down", "Enter"]\` or \`["y"]\`. Named keys: Enter, Escape, Tab, Space, BSpace, Up, Down, Left, Right, Home, End, PageUp, PageDown, Delete, C-x for Ctrl-x; any other string is typed literally.

## Good habits

- Give each session a self-contained prompt: it does not see this conversation.
- Report to the user which sessions you started, in which directories, and the name to find them by.
- Kill sessions you started once they are done, unless the user wants to keep working in them.
`;
