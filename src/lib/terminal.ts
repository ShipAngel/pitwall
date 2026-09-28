import path from "node:path";
import { findConfiguredRepo, repoId } from "./repos";
import type {
  AppConfig,
  OpenTerminal,
  PitwallTerminalSession,
  RepoConfig,
  TerminalSessionRequest,
} from "@/types";

export const DEFAULT_WORKTREE_ROOT = "~/.pitwall/worktrees";
export const DEFAULT_TERMINAL_COMMAND = ["claude"];

/** Port the terminal sidecar listens on. 3737 + 1, to keep them adjacent. */
export const TERMINAL_PORT = 3738;

/**
 * Where the sidecar writes its port and freshly-minted token, and where
 * /api/terminal reads them from. Gitignored, rewritten on every boot.
 */
export const TERMINAL_RUNTIME_FILE = ".pitwall-terminal.json";

/** What the sidecar writes to TERMINAL_RUNTIME_FILE. */
export type TerminalRuntime = { port: number; token: string };

export function parseTerminalRuntime(raw: string): TerminalRuntime {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`${TERMINAL_RUNTIME_FILE}: must be a JSON object`);
  }
  const r = parsed as Partial<TerminalRuntime>;
  if (typeof r.port !== "number" || !Number.isInteger(r.port) || r.port <= 0) {
    throw new Error(`${TERMINAL_RUNTIME_FILE}: 'port' must be a positive integer`);
  }
  if (typeof r.token !== "string" || r.token === "") {
    throw new Error(`${TERMINAL_RUNTIME_FILE}: 'token' must be a non-empty string`);
  }
  return { port: r.port, token: r.token };
}

/** Expands a leading `~` only. Anything else is left for path.resolve. */
export function expandHome(p: string, home: string): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return path.join(home, p.slice(2));
  return p;
}

/**
 * Whether a string is safe to hand to `git worktree add` as a branch name.
 *
 * The branch arrives from the browser, so this is a security boundary as much as
 * a correctness one: it is checked before the name reaches any argv. The rules
 * are git's own (`git check-ref-format`) plus a rejection of anything that could
 * be read as a flag or escape a directory.
 */
export function isValidBranchName(branch: string): boolean {
  if (!branch || branch.length > 255) return false;
  if (!/^[A-Za-z0-9._/-]+$/.test(branch)) return false;
  // A leading "-" would be parsed as a flag by git, not as a ref.
  if (branch.startsWith("-")) return false;
  if (branch.startsWith("/") || branch.endsWith("/")) return false;
  if (branch.includes("//")) return false;
  if (branch.includes("..")) return false;
  if (branch.endsWith(".")) return false;
  // git rejects path components that begin with "." or end with ".lock".
  return branch
    .split("/")
    .every((seg) => seg !== "" && !seg.startsWith(".") && !seg.endsWith(".lock"));
}

/** True for a usable PR number. Guards the value before it reaches a path. */
export function isValidPRNumber(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n > 0 && n < 10_000_000;
}

/**
 * tmux session names may not contain "." or ":" — it parses those as
 * window/pane addresses. Everything outside its safe set collapses to "-".
 */
export function sanitizeForTmux(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]+/g, "-");
}

/**
 * The tmux session for one PR, e.g. "pitwall_Northwind-forms-app_1234".
 *
 * Derived rather than stored: the same PR must resolve to the same name on every
 * boot, or reattaching after a restart would silently start a second session.
 */
export function tmuxSessionName(repo: string, prNumber: number): string {
  return `pitwall_${sanitizeForTmux(repo)}_${prNumber}`;
}

/**
 * Directory name for a PR's worktree, e.g. "pr-1234-alex-eng-5500-copy".
 *
 * The PR number leads because it alone makes the name unique — the branch is
 * flattened (worktrees stay one level deep, so "a/b" would otherwise nest) and
 * truncated, and neither of those is collision-free on its own.
 */
export function worktreeDirName(prNumber: number, branch: string): string {
  const flat = branch.replace(/\//g, "-").slice(0, 60).replace(/-+$/, "");
  return flat ? `pr-${prNumber}-${flat}` : `pr-${prNumber}`;
}

/** Absolute path of a PR's worktree. */
export function worktreePath(args: {
  root: string;
  repo: string;
  prNumber: number;
  branch: string;
  home: string;
}): string {
  const { root, repo, prNumber, branch, home } = args;
  return path.resolve(
    expandHome(root, home),
    repo.replace(/\//g, "-"),
    worktreeDirName(prNumber, branch),
  );
}

export type WorktreeEntry = {
  path: string;
  /** Short branch name, or null when bare or detached. */
  branch: string | null;
};

/**
 * Parses `git worktree list --porcelain`: blank-line-separated records, each
 * starting with "worktree <path>", with an optional "branch refs/heads/<name>".
 */
export function parseWorktreeList(porcelain: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let current: WorktreeEntry | null = null;
  for (const line of porcelain.split("\n")) {
    const trimmed = line.trimEnd();
    if (trimmed.startsWith("worktree ")) {
      if (current) entries.push(current);
      current = { path: trimmed.slice("worktree ".length), branch: null };
    } else if (trimmed.startsWith("branch ") && current) {
      current.branch = trimmed
        .slice("branch ".length)
        .replace(/^refs\/heads\//, "");
    }
  }
  if (current) entries.push(current);
  return entries;
}

/**
 * The existing worktree holding a branch, if any.
 *
 * Checked before creating one: git allows a branch to be checked out in only one
 * worktree, so without this a second PR on the same branch — or a worktree the
 * user made by hand — would fail the add instead of being reused.
 */
export function findWorktreeForBranch(
  entries: WorktreeEntry[],
  branch: string,
): string | null {
  // Detached and bare worktrees carry a null branch, so an empty needle would
  // otherwise match one of them and hand back an unrelated directory.
  if (!branch) return null;
  return entries.find((e) => e.branch === branch)?.path ?? null;
}

/**
 * The worktree already sitting at a path, if any.
 *
 * `git worktree add` refuses a path that exists at all, so this is asked before
 * creating one. The path is derived from the PR number and a *truncated* branch
 * name, and the branch inside a worktree can be switched by hand or by whatever
 * is running in it — so the directory we would create is routinely already
 * there, holding a branch `findWorktreeForBranch` doesn't recognise.
 *
 * `wtPath` must already be canonical: git reports every worktree through
 * realpath, so a path with a symlinked component compares unequal to the same
 * directory as git spells it. Resolving one needs the filesystem, which this
 * module doesn't touch — the caller does it.
 */
export function findWorktreeAtPath(
  entries: WorktreeEntry[],
  wtPath: string,
): WorktreeEntry | null {
  if (!wtPath) return null;
  const wanted = path.resolve(wtPath);
  return entries.find((e) => path.resolve(e.path) === wanted) ?? null;
}

/**
 * Wraps argv into one POSIX-shell-safe string.
 *
 * tmux takes its shell-command as a single argument that it re-parses, so an
 * argv passed as separate words would be re-split on spaces.
 */
export function shellQuote(argv: string[]): string {
  return argv
    .map((a) =>
      /^[A-Za-z0-9_./:=-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`,
    )
    .join(" ");
}

/**
 * argv for attaching to a PR's session, creating it if needed.
 *
 * `-A` is what makes the session persistent from the UI's point of view: the
 * first click creates it and runs the command, every later click attaches to the
 * one already running and the command is ignored.
 */
export function tmuxArgv(args: {
  sessionName: string;
  cwd: string;
  command: string[];
}): string[] {
  return [
    "new-session",
    "-A",
    "-s",
    args.sessionName,
    "-c",
    args.cwd,
    shellQuote(args.command),
  ];
}

/**
 * argv (after `git -C <repo>`) to create a worktree for an existing branch.
 *
 * `startPoint` is set when the branch exists only on the remote, so the worktree
 * gets a local tracking branch; when it is null the local branch is checked out
 * as-is. `--` separates the path from anything that could look like a flag.
 */
export function worktreeAddArgv(args: {
  worktreePath: string;
  branch: string;
  startPoint: string | null;
}): string[] {
  const { worktreePath: wt, branch, startPoint } = args;
  return startPoint
    ? ["worktree", "add", "--track", "-b", branch, "--", wt, startPoint]
    : ["worktree", "add", "--", wt, branch];
}

/**
 * argv (after `git -C <worktree>`) to point an existing worktree at a branch.
 *
 * The counterpart to `worktreeAddArgv` for a directory that is already a
 * worktree, and `startPoint` means the same thing here: set when the branch is
 * remote-only, so a local tracking branch is created. Safe to attempt blind —
 * git refuses the switch rather than overwriting uncommitted work.
 */
export function worktreeCheckoutArgv(args: {
  branch: string;
  startPoint: string | null;
}): string[] {
  return args.startPoint
    ? ["checkout", "--track", "-b", args.branch, args.startPoint]
    : ["checkout", args.branch];
}

export function terminalsEnabled(config: AppConfig): boolean {
  return config.terminals?.enabled === true;
}

/**
 * The dock's whole state: which terminals are open, and which one is showing.
 *
 * One object rather than two `useState`s because the two must agree — `activeKey`
 * is always one of `terminals`' keys, or null when there are none. Held apart,
 * closing a tab meant updating both, and the only way to do that in one event was
 * to call one setter inside the other's updater, which React doesn't support:
 * updaters must be pure, and Strict Mode invokes them twice to prove it.
 */
export type DockState = {
  terminals: OpenTerminal[];
  activeKey: string | null;
};

export const EMPTY_DOCK: DockState = { terminals: [], activeKey: null };

/** The dock entry for a PR. Snapshotted so a refresh can't mutate it. */
export function dockTerminalForPR(pr: {
  repo: string;
  number: number;
  headRefName: string;
  title: string;
}): OpenTerminal {
  return {
    key: terminalSessionKey(pr.repo, pr.number),
    repo: pr.repo,
    prNumber: pr.number,
    branch: pr.headRefName,
    title: pr.title,
  };
}

/**
 * Opens a terminal, or brings it forward if it's already open.
 *
 * Never duplicates: a second click on the same PR should reveal the session it
 * already has, not start a second one.
 */
export function openDockTerminal(state: DockState, terminal: OpenTerminal): DockState {
  const already = state.terminals.find((t) => sameTerminalKey(t.key, terminal.key));
  return {
    terminals: already ? state.terminals : [...state.terminals, terminal],
    activeKey: already?.key ?? terminal.key,
  };
}

/**
 * Whether two terminal keys name the same PR.
 *
 * Case-insensitive because the two sides of the dashboard spell a repo
 * differently: a pane opened from a PR row carries GitHub's casing, and the
 * Sessions panel's rows carry config.json's. Exact comparison meant ending a
 * session from the panel left its dock pane open on a dead session.
 */
export function sameTerminalKey(a: string | null, b: string | null): boolean {
  return a !== null && b !== null && a.toLowerCase() === b.toLowerCase();
}

/**
 * Closes a terminal and, if it was the visible one, shows its neighbour — the
 * tab that slides into its place, or the one before it when it was last. Closing
 * an inactive tab leaves the selection alone.
 */
export function closeDockTerminal(state: DockState, key: string): DockState {
  const index = state.terminals.findIndex((t) => sameTerminalKey(t.key, key));
  if (index === -1) return state;

  const terminals = state.terminals.filter((_, i) => i !== index);
  if (!sameTerminalKey(state.activeKey, key)) return { terminals, activeKey: state.activeKey };

  const neighbour = terminals[index] ?? terminals[index - 1];
  return { terminals, activeKey: neighbour?.key ?? null };
}

/**
 * Runs work one-at-a-time per key, sharing the result with concurrent callers.
 *
 * Preparing a worktree is check-then-create, and nothing in git holds that pair
 * atomically: two sockets for the same branch — a second browser tab, or two PRs
 * sharing a head branch — would both see no worktree and both run
 * `git worktree add` on the same path. The second fails with "already exists",
 * reporting a broken session that is actually fine.
 *
 * Callers that arrive while work is in flight await the same promise rather than
 * queueing behind it: they want the same answer, not a second attempt. The entry
 * is dropped once settled, so a later call re-runs (a worktree can be deleted
 * between visits) and a failure isn't cached.
 */
export function createKeyedSerializer<T>() {
  const inFlight = new Map<string, Promise<T>>();
  return function serialize(key: string, work: () => Promise<T>): Promise<T> {
    const existing = inFlight.get(key);
    if (existing) return existing;
    const started = work().finally(() => inFlight.delete(key));
    inFlight.set(key, started);
    return started;
  };
}

/** Repos a terminal can be opened for: configured, with a local clone. */
export function terminalCapableRepos(config: AppConfig): RepoConfig[] {
  if (!terminalsEnabled(config)) return [];
  return config.repos.filter((r) => typeof r.localPath === "string" && r.localPath !== "");
}

export type TerminalTarget = {
  sessionName: string;
  /** The local clone the worktree is added to. */
  repoPath: string;
  worktreePath: string;
  branch: string;
  command: string[];
};

/**
 * Turns a browser's {repo, prNumber, headRefName} into everything needed to
 * spawn its session — or throws.
 *
 * The client sends identifiers only; every path and argument is derived here
 * from config. That is deliberate: nothing the browser sends is ever executed,
 * and a repo missing from config.json has no terminal at all.
 */
export function resolveTerminalTarget(args: {
  config: AppConfig;
  request: TerminalSessionRequest;
  home: string;
}): TerminalTarget {
  const { config, request, home } = args;

  if (!terminalsEnabled(config)) {
    throw new Error("Terminals are disabled — set terminals.enabled in config.json");
  }
  if (!isValidPRNumber(request.prNumber)) {
    throw new Error(`Invalid PR number: ${String(request.prNumber)}`);
  }
  if (!isValidBranchName(request.branch)) {
    throw new Error(`Invalid branch name: ${String(request.branch)}`);
  }

  const repo = findConfiguredRepo(config, request.repo);
  if (!repo) {
    throw new Error(`Repo is not in config.json: ${request.repo}`);
  }
  if (!repo.localPath) {
    throw new Error(
      `No localPath configured for ${request.repo} — add it to config.json to open terminals there`,
    );
  }

  const root = config.terminals?.worktreeRoot ?? DEFAULT_WORKTREE_ROOT;
  // The config's spelling, not the request's: GitHub may report different
  // casing, and the session name has to match what the Sessions panel derives.
  const canonical = repoId(repo);
  return {
    sessionName: tmuxSessionName(canonical, request.prNumber),
    repoPath: path.resolve(expandHome(repo.localPath, home)),
    worktreePath: worktreePath({
      root,
      repo: canonical,
      prNumber: request.prNumber,
      branch: request.branch,
      home,
    }),
    branch: request.branch,
    command: config.terminals?.command ?? DEFAULT_TERMINAL_COMMAND,
  };
}

/**
 * Identity of an open terminal in the UI, e.g. "Northwind/forms-app#1234".
 *
 * Panes are keyed by this rather than by array position so that a dashboard
 * refresh — which replaces every MyPR object — doesn't remount them and drop the
 * sockets.
 */
export function terminalSessionKey(repo: string, prNumber: number): string {
  return `${repo}#${prNumber}`;
}

/** Tab label. The owner is dropped: every repo in one dashboard shares it. */
export function terminalTabLabel(repo: string, prNumber: number): string {
  return `${repo.split("/").pop() ?? repo} #${prNumber}`;
}

/**
 * Field separator for the tmux `-F` formats below. A pipe can't appear in a
 * session name (`sanitizeForTmux` strips it) and won't appear in a tty path, so
 * splitting on it is safe where splitting on whitespace would not be.
 */
const TMUX_FIELD_SEP = "|";

/** `tmux list-sessions -F` with this returns one parseable line per session. */
export const TMUX_LIST_SESSIONS_FORMAT =
  "#{session_name}|#{session_created}|#{session_attached}";

/**
 * `tmux list-panes -a -F` with this maps every pane back to its session.
 *
 * The path is last so that a directory containing the separator still parses:
 * the name and tty are read as the first two fields and everything after is
 * rejoined, rather than a `|` in a path shifting the columns.
 */
export const TMUX_LIST_PANES_FORMAT =
  "#{session_name}|#{pane_tty}|#{pane_current_path}";

export type TmuxSessionRow = {
  name: string;
  /** Unix seconds, as tmux reports it. */
  created: number;
  /** A client is currently attached — i.e. a dock pane has it open. */
  attached: boolean;
};

/**
 * Parses `tmux list-sessions -F TMUX_LIST_SESSIONS_FORMAT`.
 *
 * Malformed lines are dropped rather than throwing: tmux is optional, and a
 * format it didn't understand should cost the panel a row, not the whole list.
 */
export function parseTmuxSessions(raw: string): TmuxSessionRow[] {
  const rows: TmuxSessionRow[] = [];
  for (const line of raw.split("\n")) {
    const [name, created, attached] = line.trim().split(TMUX_FIELD_SEP);
    if (!name || created === undefined) continue;
    const createdNum = Number(created);
    if (!Number.isFinite(createdNum)) continue;
    // `session_attached` is a client *count*, not a flag — two dashboard tabs
    // with the same PR's pane open make it "2". Compared against "1" that read
    // as detached, which is exactly backwards.
    rows.push({ name, created: createdNum, attached: Number(attached) > 0 });
  }
  return rows;
}

/**
 * Parses `tmux list-panes -a -F TMUX_LIST_PANES_FORMAT` into tty → session name.
 *
 * This is the join that lets the Sessions panel tell a terminal Pitwall started
 * from one you opened yourself. Matching on the working directory would not: a
 * PR whose branch is already checked out in your main clone reuses it, so its
 * pane's cwd is an ordinary repo path indistinguishable from any other.
 */
export function parseTmuxPaneTtys(raw: string): Map<string, string> {
  const byTty = new Map<string, string>();
  for (const line of raw.split("\n")) {
    const [name, tty] = line.trim().split(TMUX_FIELD_SEP);
    if (!name || !tty) continue;
    byTty.set(normalizeTty(tty), name);
  }
  return byTty;
}

/**
 * Parses the same output into session name → working directory.
 *
 * For display only, and deliberately so: it is how a row can say the session is
 * sitting in your main clone rather than in a worktree of its own. It must never
 * decide what gets deleted — a pane can be `cd`'d anywhere, so removal resolves
 * the path from `git worktree list` instead.
 *
 * The first pane wins where a session has several; they start in one directory
 * and only diverge if you split the window.
 */
export function parseTmuxPaneCwds(raw: string): Map<string, string> {
  const byName = new Map<string, string>();
  for (const line of raw.split("\n")) {
    const parts = line.trim().split(TMUX_FIELD_SEP);
    if (parts.length < 3) continue;
    const [name] = parts;
    // Rejoined rather than taken as parts[2], so a path containing the
    // separator survives.
    const cwd = parts.slice(2).join(TMUX_FIELD_SEP);
    if (!name || !cwd || byName.has(name)) continue;
    byName.set(name, cwd);
  }
  return byName;
}

/**
 * `ps` says "ttys001" where tmux says "/dev/ttys001". Everything joins on the
 * tty, so both spellings are reduced to the bare device name first.
 */
export function normalizeTty(tty: string): string {
  return tty.replace(/^\/dev\//, "");
}

/**
 * The tmux sessions Pitwall started, resolved back to the PRs they belong to.
 *
 * Matched forwards — `tmuxSessionName` is computed for each configured repo and
 * compared — rather than by parsing the name apart. The name is lossy by
 * construction: `sanitizeForTmux` turns both "a/b" and "a.b" into "a-b", so
 * reversing it would guess. A session whose repo has since left config.json
 * therefore doesn't appear, which is the safe direction: the UI only offers
 * actions on sessions it can still name.
 */
export function pitwallTerminalSessions(args: {
  rows: TmuxSessionRow[];
  config: AppConfig;
  /** Session name → pane working directory, for display. Optional. */
  cwds?: Map<string, string>;
}): PitwallTerminalSession[] {
  const { rows, config, cwds } = args;
  const byName = new Map<string, { repo: string; prNumber: number }>();

  for (const row of rows) {
    // The PR number is the trailing segment; everything before it is the
    // sanitized repo. Parsed only to know which repo to *test*, never trusted.
    const match = /^pitwall_(.+)_(\d+)$/.exec(row.name);
    if (!match) continue;
    const prNumber = Number(match[2]);
    if (!isValidPRNumber(prNumber)) continue;

    // Every match is collected, not the first: if two configured repos produce
    // this name, the session belongs to neither unambiguously, and a row that
    // guessed could open — or end — the other repo's session. `validateConfig`
    // rejects such a config outright when terminals are on; this is the second
    // lock, so the function is safe on any input rather than only a validated
    // one.
    // A Set, not a list: the same repo listed twice is a duplicate entry, not a
    // collision — there is only one repo it could mean.
    const matches = new Set<string>();
    for (const repo of config.repos) {
      const slug = `${repo.owner}/${repo.name}`;
      if (tmuxSessionName(slug, prNumber) === row.name) matches.add(slug);
    }
    if (matches.size === 1) {
      byName.set(row.name, { repo: [...matches][0], prNumber });
    }
  }

  return rows
    .filter((row) => byName.has(row.name))
    .map((row) => {
      const { repo, prNumber } = byName.get(row.name)!;
      return {
        sessionName: row.name,
        repo,
        prNumber,
        createdAt: new Date(row.created * 1000).toISOString(),
        attached: row.attached,
        cwd: cwds?.get(row.name) ?? null,
      };
    });
}

/**
 * The ttys belonging to Pitwall's own tmux sessions.
 *
 * The Sessions panel subtracts these from what it discovered, so a terminal this
 * app started is listed once — under the terminals it owns and can act on —
 * rather than twice, the second time as an inert row it can only refuse to
 * focus.
 */
export function pitwallOwnedTtys(args: {
  paneTtys: Map<string, string>;
  sessions: PitwallTerminalSession[];
}): Set<string> {
  const names = new Set(args.sessions.map((s) => s.sessionName));
  const owned = new Set<string>();
  for (const [tty, sessionName] of args.paneTtys) {
    if (names.has(sessionName)) owned.add(tty);
  }
  return owned;
}

/** argv to end one session. Separated so the route never builds a name itself. */
export function tmuxKillSessionArgv(sessionName: string): string[] {
  return ["kill-session", "-t", `=${sessionName}`];
}

/**
 * WebSocket close reasons the client tells apart.
 *
 * `CLOSE_SESSION_ENDED` exists because "the pty went away" has two very
 * different meanings: you detached and the session is still there to go back to,
 * or the session is gone. Conflated, the UI reports "the tmux session is still
 * running" over one that was just killed, and offers a Reconnect that would
 * quietly start a *new* session — `tmuxArgv` uses `new-session -A`, so
 * reattaching to something that no longer exists creates it.
 */
export const CLOSE_SESSION_FAILED = "session-failed";
export const CLOSE_PTY_EXIT = "pty-exit";
export const CLOSE_SESSION_ENDED = "session-ended";

/** argv asking whether a session still exists; the exit code is the answer. */
export function tmuxHasSessionArgv(sessionName: string): string[] {
  return ["has-session", "-t", `=${sessionName}`];
}

/**
 * argv listing just the ttys one session occupies.
 *
 * Read *before* killing it. `kill-session` returns as soon as tmux has forgotten
 * the session, but the process inside is only then being SIGHUPped and takes a
 * moment to go — measured at ~240ms for a trivial one, longer for Claude Code,
 * which has cleanup to do. In that window tmux no longer claims the tty, so the
 * Sessions panel stops attributing it to a hosted terminal and the dying process
 * surfaces in the *discovered* list instead, as an inert "no window" row. Since
 * a kill triggers an immediate refetch, that window is exactly what you see.
 * Knowing the ttys is what lets the route wait for them to clear first.
 */
export function tmuxListSessionTtysArgv(sessionName: string): string[] {
  // `-s` makes the target a session, so every window's panes are listed. Without
  // it tmux lists only the current window, and a session with a second window
  // would be "drained" while that window's processes were still running.
  // Verified against a two-window session on a scratch tmux server.
  return ["list-panes", "-s", "-t", `=${sessionName}`, "-F", "#{pane_tty}"];
}

/** The ttys from `tmuxListSessionTtysArgv`, normalised for joining against ps. */
export function parseSessionTtys(raw: string): string[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map(normalizeTty);
}

/**
 * Whether any of those ttys still has a process on it, given `ps -eo tty,comm`.
 *
 * Deliberately any process, not just Claude: the pane's shell counts too, and
 * "the terminal is gone" is the condition worth waiting for.
 */
export function anyTtyOccupied(psOutput: string, ttys: readonly string[]): boolean {
  if (ttys.length === 0) return false;
  const wanted = new Set(ttys.map(normalizeTty));
  return psOutput
    .split("\n")
    .slice(1)
    .some((line) => {
      const tty = line.trim().split(/\s+/)[0];
      return Boolean(tty) && wanted.has(normalizeTty(tty));
    });
}

export const DOCK_MIN_HEIGHT = 160;
export const DOCK_MAX_HEIGHT = 900;
export const DOCK_DEFAULT_HEIGHT = 380;

/**
 * A dock height to trust, given whatever localStorage returned.
 *
 * Anything unparseable or out of range falls back to the default rather than
 * being clamped into it: a stored "0" or "NaN" means the value is junk, and a
 * 160px-tall terminal is worse than the size the user has never chosen.
 */
export function clampDockHeight(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < DOCK_MIN_HEIGHT || n > DOCK_MAX_HEIGHT) {
    return DOCK_DEFAULT_HEIGHT;
  }
  return Math.round(n);
}

/** Keeps a drag within bounds. Unlike a stored value, a drag is clamped. */
export function clampDragHeight(value: number): number {
  return Math.min(DOCK_MAX_HEIGHT, Math.max(DOCK_MIN_HEIGHT, Math.round(value)));
}

/** The socket URL for one PR's session, including the size to start at. */
export function terminalSocketUrl(args: {
  wsUrl: string;
  token: string;
  repo: string;
  prNumber: number;
  branch: string;
  cols: number;
  rows: number;
}): string {
  const params = new URLSearchParams({
    token: args.token,
    repo: args.repo,
    pr: String(args.prNumber),
    branch: args.branch,
    cols: String(args.cols),
    rows: String(args.rows),
  });
  return `${args.wsUrl.replace(/\/$/, "")}/?${params.toString()}`;
}

/**
 * Rejects cross-origin socket opens. WebSockets are exempt from CORS, so without
 * this any page you have open in the browser could drive the sidecar.
 *
 * Deliberately *not* `isSameOrigin` from lib/sessions.ts, which compares the
 * `Origin` header against the request's own `Host`. That works for a route,
 * which shares an origin with the page. The sidecar doesn't: it listens on its
 * own port, so a same-origin test would reject the dashboard and accept nothing.
 * It has to allow-list the app's origin by name instead — hence the port
 * argument, and the exact-match comparison rather than a prefix (which would let
 * `http://localhost:3737.evil.com` through).
 */
export function isAllowedOrigin(origin: string | undefined, appPort: number): boolean {
  if (!origin) return false;
  return (
    origin === `http://localhost:${appPort}` ||
    origin === `http://127.0.0.1:${appPort}`
  );
}
