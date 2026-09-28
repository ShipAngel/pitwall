import type { ClaudeSession, FocusResponse } from "@/types";

/**
 * Finding the terminals running Claude Code, and joining them to something you
 * can click.
 *
 * Three sources, joined on the tty:
 *   ps    — which processes are Claude Code, and on which terminal device
 *   lsof  — each process's working directory, so a row can name its repo
 *   iTerm2 — the terminal's own title, and whether it can be focused at all
 *
 * All of it is parsing, so all of it is here and tested. The commands live in
 * the route.
 */

/**
 * Everything in this file joins on the tty, so the two spellings have to be
 * reconciled: `ps` reports `ttys001` while iTerm2 reports `/dev/ttys001`.
 */
export function normalizeTty(raw: string): string {
  const t = raw.trim();
  if (!t || t === "??" || t === "?") return "";
  return t.startsWith("/dev/") ? t : `/dev/${t}`;
}

/**
 * The only tty shape the focus endpoint will act on.
 *
 * Deliberately strict. The value arrives from an HTTP request and ends up in an
 * `osascript` argument, so it is allow-listed to a device name rather than
 * escaped — nothing that isn't literally a pty can get through.
 */
const TTY_PATTERN = /^\/dev\/ttys[0-9]{1,4}$/;

export function isValidTty(tty: unknown): tty is string {
  return typeof tty === "string" && TTY_PATTERN.test(tty);
}

/**
 * The only Host values Pitwall answers to: a local name and an optional port,
 * and nothing else. Matched as a whole string rather than parsed with `URL`,
 * which reads `evil.example:3737@localhost:3737` as userinfo plus `localhost`.
 */
const LOCAL_HOST = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i;

/**
 * Whether a request's `Host` header names this machine.
 *
 * Binding to 127.0.0.1 keeps other machines out, but not other *websites*: a page
 * can point its own hostname at 127.0.0.1 (DNS rebinding), and the browser then
 * treats the dashboard as that site. Every request it sends carries the attacker's
 * hostname in `Host`, so refusing anything but a local name closes the hole for
 * reads and writes alike. `src/proxy.ts` applies this to every request.
 *
 * Any port is accepted: the attack needs a hostname the attacker controls, never
 * a port, and pinning 3737 here would break anyone who runs `next dev -p` on
 * another one.
 */
export function isAllowedHost(host: string | null): boolean {
  return host !== null && LOCAL_HOST.test(host);
}

/**
 * Whether a request came from the dashboard itself.
 *
 * The write routes (focusing a terminal, ending one, Start Work) must not be
 * reachable from any other page. Without this, any site you happened to visit
 * could POST to localhost:3737 and the browser would send the request quite
 * happily.
 *
 * Origin must match Host *and* both must be local. Matching alone is not enough:
 * under DNS rebinding the attacker's page sends `Origin: http://evil.example:3737`
 * with `Host: evil.example:3737`, which match perfectly.
 *
 * A missing `Origin` is refused rather than trusted: browsers send it on every
 * `fetch` POST, so its absence means the caller isn't the dashboard.
 */
export function isSameOrigin(origin: string | null, host: string | null): boolean {
  if (!origin || !host || !isAllowedHost(host)) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/**
 * Whether iTerm2 is running, from the same raw `ps` output the session scan
 * reads. Raw, not `parsePsOutput`'s rows: those drop every process without a
 * terminal, and iTerm2 itself is one. Its process shows as the full bundle path
 * ending in `/MacOS/iTerm2`, so `pgrep -x iTerm2` finds nothing (checked live).
 */
export function isITermRunning(psStdout: string): boolean {
  return /\/MacOS\/iTerm2\s*$/m.test(psStdout);
}

/**
 * Why none of the found sessions can be focused, in the terms a user can act on.
 *
 * iTerm2 not running is the common cause on a machine that uses another
 * terminal; the Automation permission is the cause when it is running, because
 * osascript returns nothing rather than erroring when it's refused.
 */
export function unfocusableReason(itermRunning: boolean): string {
  return itermRunning
    ? "Found sessions but no iTerm2 window for any of them. macOS may not have granted Automation access to iTerm2."
    : "Found sessions, but iTerm2 isn't running. Focusing a session works with iTerm2 only.";
}

export type PsRow = { pid: number; tty: string; command: string };

// pid, tty, then the command — which can contain spaces, so it takes the rest.
const PS_LINE = /^\s*(\d+)\s+(\S+)\s+(.*)$/;

/** Rows of `ps -eo pid,tty,comm`, dropping the header and anything ttyless. */
export function parsePsOutput(stdout: string): PsRow[] {
  const rows: PsRow[] = [];
  for (const line of stdout.split("\n")) {
    const m = PS_LINE.exec(line);
    if (!m) continue;
    const tty = normalizeTty(m[2]);
    // No controlling terminal means no terminal to focus — this is what excludes
    // every process of the Claude *desktop app*, which reports "??".
    if (!tty) continue;
    rows.push({ pid: Number(m[1]), tty, command: m[3].trim() });
  }
  return rows;
}

/** A command's own name, without the path it was launched from. */
function baseName(command: string): string {
  const slash = command.lastIndexOf("/");
  return slash === -1 ? command : command.slice(slash + 1);
}

/**
 * The Claude Code processes among a `ps` listing.
 *
 * The bundled desktop app also has executables named "Claude", and while they
 * carry no tty today that is the only thing separating them — so the app bundle
 * is excluded by path too, rather than resting on one condition.
 */
export function claudeProcesses(rows: readonly PsRow[]): PsRow[] {
  return rows.filter(
    (r) =>
      /^claude/i.test(baseName(r.command)) && !r.command.includes("/Claude.app/"),
  );
}

/**
 * Working directories from `lsof -d cwd -Fpn`, which emits `p<pid>`, `fcwd` and
 * `n<path>` on separate lines.
 *
 * One call for every process rather than one per pid: `lsof` ignores `-p` in
 * this environment and dumps everything regardless, so filtering by pid here is
 * both cheaper and the only thing that actually works.
 */
export function parseLsofCwds(stdout: string): Map<number, string> {
  const cwds = new Map<number, string>();
  let pid: number | null = null;
  let inCwdRecord = false;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("p")) {
      const n = Number(line.slice(1));
      pid = Number.isInteger(n) ? n : null;
      inCwdRecord = false;
    } else if (line.startsWith("f")) {
      // A path is only a working directory if it belongs to the `cwd`
      // descriptor. `-d cwd` should make that the only one present, but taking
      // any `n` line on trust means a widened filter — or an lsof that emits
      // more fields — silently reports an unrelated open file as the cwd.
      inCwdRecord = line.slice(1) === "cwd";
    } else if (line.startsWith("n") && pid !== null && inCwdRecord) {
      // First path wins; a process has one cwd.
      if (!cwds.has(pid)) cwds.set(pid, line.slice(1));
    }
  }
  return cwds;
}

/**
 * The title is kept exactly as iTerm2 reported it. Cleaning it here would strip
 * the spinner that `isWorking` needs to see — which is precisely the bug this
 * shape now prevents, caught only by reading the live endpoint.
 */
export type ITermSession = { tty: string; rawTitle: string };

/**
 * iTerm2's sessions, keyed by tty, from the tab-delimited dump the route asks
 * for: `window`, `tab`, `tty`, `name`.
 *
 * The window and tab indices are read and discarded on purpose. iTerm2 numbers
 * windows by z-order, so they change as soon as you focus something else —
 * they were observed shifting between two calls seconds apart. Storing them and
 * focusing "window 1, tab 1" later would reliably select the wrong terminal.
 * The tty is the only stable handle, so focusing re-searches by it at click time.
 */
export function parseITermSessions(stdout: string): Map<string, ITermSession> {
  const sessions = new Map<string, ITermSession>();
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    // The name is last because a terminal title may itself contain a tab.
    const parts = line.split("\t");
    if (parts.length < 4) continue;
    const tty = normalizeTty(parts[2]);
    if (!tty) continue;
    if (!sessions.has(tty)) {
      sessions.set(tty, { tty, rawTitle: parts.slice(3).join("\t") });
    }
  }
  return sessions;
}

/**
 * The two title shapes Claude Code actually writes, read off a live iTerm2:
 *
 *   idle     "✳ Claude Code"                         U+2733
 *   working  "⠐ Add review requested section…"       a braille spinner frame
 *
 * iTerm2 then appends the foreground job — "(node)" — to whichever it is.
 */
const SPINNER_FRAME = /^\s*[⠀-⣿]/;
const LEADING_GLYPH = /^\s*[✳⠀-⣿]+\s*/;
const JOB_SUFFIX = /\s*\([^()]*\)\s*$/;

/** Claude Code's placeholder title when it has no task to name. */
const IDLE_TITLE = "Claude Code";

/**
 * Whether the terminal's title says Claude is mid-turn.
 *
 * A heuristic that fails quiet: it looks for the braille spinner frame Claude
 * Code animates while a turn is in flight. Requires an actual braille codepoint
 * rather than "starts with whitespace", so a title that merely begins with a
 * space isn't read as working. If the format ever changes this returns false and
 * the row shows no indicator — which is why the UI only badges "working" and
 * never claims a session is idle.
 */
export function isWorking(rawTitle: string): boolean {
  return SPINNER_FRAME.test(rawTitle);
}

/**
 * A terminal title fit to display: without its leading glyph, without the job
 * name iTerm2 appends, and empty when all that's left is the idle placeholder —
 * "Claude Code" on every idle row says nothing the panel heading hasn't.
 */
export function cleanTitle(rawTitle: string): string {
  const cleaned = rawTitle.replace(JOB_SUFFIX, "").replace(LEADING_GLYPH, "").trim();
  return cleaned === IDLE_TITLE ? "" : cleaned;
}

/**
 * The name for a session's directory — the last path segment, which for a
 * `repo@label` worktree layout is already the useful label ("forms-app@feature-x").
 * A session run from a subdirectory names the subdirectory, which is honest: it
 * is the working directory, not a claim about the repo.
 */
export function workspaceName(cwd: string): string {
  const trimmed = cwd.replace(/\/+$/, "");
  if (!trimmed) return "";
  const slash = trimmed.lastIndexOf("/");
  return slash === -1 ? trimmed : trimmed.slice(slash + 1);
}

/** A path with the home directory collapsed to `~`, for a tooltip. */
export function shortenPath(cwd: string, home: string): string {
  if (home && cwd === home) return "~";
  if (home && cwd.startsWith(`${home}/`)) return `~${cwd.slice(home.length)}`;
  return cwd;
}

/**
 * Joins the three sources into rows.
 *
 * A Claude process with no iTerm2 session behind it still appears — it may be in
 * tmux, or another terminal entirely — but is marked unfocusable rather than
 * offering a click that could only fail.
 */
export function buildSessions(
  processes: readonly PsRow[],
  cwds: ReadonlyMap<number, string>,
  iterm: ReadonlyMap<string, ITermSession>,
  home = "",
): ClaudeSession[] {
  const rows = processes.map((p) => {
    const cwd = cwds.get(p.pid) ?? "";
    const session = iterm.get(p.tty);
    const rawTitle = session?.rawTitle ?? "";
    return {
      pid: p.pid,
      tty: p.tty,
      cwd,
      path: shortenPath(cwd, home),
      workspace: workspaceName(cwd),
      title: cleanTitle(rawTitle),
      isWorking: isWorking(rawTitle),
      canFocus: session !== undefined,
    };
  });
  return sortSessions(rows);
}

/**
 * Working sessions first, then alphabetically by workspace.
 *
 * The one thing you scan this list for is which session is mid-task, and a
 * stable secondary order keeps rows from reshuffling under the cursor on every
 * refresh — pids would order by whenever a session happened to start.
 */
export function sortSessions(sessions: readonly ClaudeSession[]): ClaudeSession[] {
  return [...sessions].sort((a, b) => {
    if (a.isWorking !== b.isWorking) return a.isWorking ? -1 : 1;
    const byName = a.workspace.localeCompare(b.workspace);
    return byName !== 0 ? byName : a.pid - b.pid;
  });
}

/**
 * What the focus script's one-word result means.
 *
 * "not-found" is the ordinary outcome rather than an error: the list is a
 * snapshot, so a session that has since exited is expected, and saying so beats
 * a failure that sounds like a bug.
 */
export function focusOutcome(stdout: string): FocusResponse {
  switch (stdout.trim()) {
    case "focused":
      return { focused: true, detail: "Brought to the front." };
    case "not-running":
      return { focused: false, detail: "iTerm2 isn't running." };
    default:
      return { focused: false, detail: "That terminal is no longer open." };
  }
}

/**
 * macOS refuses Apple events from an app the user hasn't approved, and reports it
 * as "Not authorized to send Apple events" / error -1743 — a message that says
 * nothing about the one action that fixes it. Anything else is passed through
 * unchanged rather than guessed at.
 */
export function focusErrorDetail(message: string): string {
  return /not authoriz|-1743/i.test(message)
    ? "macOS blocked the request. Grant Automation access to iTerm2 in System Settings › Privacy & Security › Automation."
    : message;
}

/** One line describing the session list. */
export function summarizeSessions(sessions: readonly ClaudeSession[]): string {
  if (sessions.length === 0) return "no sessions running";
  const working = sessions.filter((s) => s.isWorking).length;
  const base = `${sessions.length} ${sessions.length === 1 ? "session" : "sessions"}`;
  return working > 0 ? `${base} · ${working} working` : base;
}
