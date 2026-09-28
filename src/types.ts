export type RepoConfig = {
  owner: string;
  name: string;
  /**
   * Absolute path (`~` allowed) to your local clone. Only needed for per-PR
   * terminals — it is the repo the worktrees are added to. Repos without it
   * still appear in every panel; they just can't open a terminal.
   */
  localPath?: string;
};

export type LinearConfig = {
  teamKey: string;
  /**
   * Workflow state "Start work" moves a ticket into. Defaults to "In Progress".
   * A name that doesn't exist on the team is reported rather than guessed at —
   * see `planIssueUpdate`.
   */
  inProgressStatusName?: string;
};

/**
 * Per-PR terminal sessions. Off unless `enabled` is true: this is the one part
 * of Pitwall that runs local commands, so it opts in rather than out.
 */
export type TerminalConfig = {
  enabled: boolean;
  /** Where per-PR git worktrees are created. Defaults to "~/.pitwall/worktrees". */
  worktreeRoot?: string;
  /** argv of the program each session runs. Defaults to ["claude"]. */
  command?: string[];
};

export type AppConfig = {
  repos: RepoConfig[];
  linear: LinearConfig;
  refreshIntervalSeconds: number;
  /** PR label that marks work-in-progress; excluded from the review count. Defaults to "wip". */
  wipLabel?: string;
  /** Team Pulse counts at or above this turn red. Defaults to 10. */
  hotspotThreshold?: number;
  terminals?: TerminalConfig;
};

export type ReviewDecision =
  | "APPROVED"
  | "CHANGES_REQUESTED"
  | "REVIEW_REQUIRED"
  | null;

export type MyPR = {
  repo: string;
  url: string;
  title: string;
  number: number;
  isDraft: boolean;
  reviewDecision: ReviewDecision;
  createdAt: string;
  /** True when the PR carries the configured WIP label. */
  isWip: boolean;
  /** Head branch, e.g. "alex/eng-5406-login-a11y" — the fallback ticket source. */
  headRefName: string;
  /**
   * True when the head branch lives in a fork. Terminals are hidden for these:
   * the branch isn't on origin, and a fork's "main" would open your own main.
   */
  isCrossRepository: boolean;
  /**
   * GitHub's own merge-button state. "UNKNOWN" until GitHub computes
   * mergeability, which it does lazily — it resolves on a later refresh.
   */
  mergeStateStatus: MergeStateStatus;
  /** Rolled-up state of the head commit's checks, or null when there are none. */
  ciState: CIState;
  /** The merge queue's view of this PR, or null when it isn't in one. */
  mergeQueue: MergeQueue | null;
};

/**
 * A PR's place in a merge queue.
 *
 * Its own field because `mergeStateStatus` has no queue member: a queued PR
 * reports `CLEAN`, which used to badge green "ready to merge" on a PR whose
 * merge button GitHub had already replaced.
 */
export type MergeQueue = {
  /** GitHub's MergeQueueEntryState, unnarrowed — only UNMERGEABLE is acted on. */
  state: string | null;
  position: number | null;
};

/** GitHub's MergeStateStatus enum, plus UNKNOWN for the not-yet-computed case. */
export type MergeStateStatus =
  | "CLEAN"
  | "HAS_HOOKS"
  | "UNSTABLE"
  | "BLOCKED"
  | "BEHIND"
  | "DIRTY"
  | "UNKNOWN";

/**
 * Rolled-up commit check state.
 *
 * `CANCELLED` is ours, not GitHub's. GitHub rolls a cancelled check up as
 * `FAILURE` — the same value a genuinely broken build gets — so a run that was
 * superseded by a newer push read as "checks failed" on a PR where everything
 * that finished had passed. `toCIState` tells the two apart, preferring the
 * check-suite conclusions and falling back to the per-state counts. Skipped and
 * neutral runs need no such rescue: GitHub already rolls those up as `SUCCESS`.
 */
export type CIState =
  | "SUCCESS"
  | "PENDING"
  | "FAILURE"
  | "ERROR"
  | "EXPECTED"
  | "CANCELLED"
  | null;

/**
 * The per-state tallies hanging off a `statusCheckRollup`'s context connection.
 *
 * Everything is optional because every field here is one GitHub could stop
 * sending, and `toCIState` has to fall back to the plain rollup state rather
 * than reason from a missing count. Names are GitHub's own enums, kept as
 * strings so an enum member added upstream lands in the "not a failure we
 * recognise" bucket instead of failing to parse.
 */
export type RollupContextCounts = {
  checkRunCountsByState?: Array<{ state?: string | null; count?: number | null }> | null;
  statusContextCountsByState?: Array<{
    state?: string | null;
    count?: number | null;
  }> | null;
};

/**
 * The conclusions of the check suites attached to a commit.
 *
 * One commit carries a suite per workflow run, and a run that a newer one
 * supersedes stays attached with its own conclusion rather than disappearing.
 * That is the blind spot in `RollupContextCounts`: its per-state tallies are
 * summed across *every* suite on the commit, so a job that failed in a dead run
 * is counted the same as one failing right now, and the rollup stays red with
 * nothing left to fix. A suite's own conclusion is what says whether the run it
 * belongs to actually reached a bad verdict.
 *
 * `totalCount` guards the page: a failing suite past the end of what we fetched
 * would otherwise read as no failing suite at all, so the list is trusted only
 * when it came back whole. Optional throughout for the same reason as
 * `RollupContextCounts` — missing data must fall back, never assert.
 */
export type CheckSuiteConclusions = {
  totalCount?: number | null;
  nodes?: Array<{
    conclusion?: string | null;
    /** GitHub's CheckStatusState — only `COMPLETED` has finished judging. */
    status?: string | null;
    /** Orders re-runs of the same workflow; the newest is the live one. */
    createdAt?: string | null;
    /**
     * Which workflow produced the run. This is the *identity* a re-run shares
     * with the run it replaces, so it is what groups a superseded suite with
     * the one that superseded it. Null on suites posted by apps rather than
     * Actions (CodeRabbit, Claude), which sit `QUEUED` indefinitely and never
     * conclude — they are grouped by app instead, and never counted as pending.
     */
    workflowRun?: { workflow?: { id?: string | null } | null } | null;
    app?: { slug?: string | null } | null;
  } | null> | null;
};

/**
 * An open PR that GitHub has requested the viewer's review on.
 *
 * Deliberately not `MyPR & { author }`: `mergeStateStatus` is a merger's concern
 * rather than a reviewer's, and GitHub computes it only for actors with push
 * access — requesting it on a repo you were merely invited to review risks a
 * field-level error, which `fetchGitHubGraphQL` turns into a failure of the whole
 * query and would take the rest of the GitHub panel down with it.
 */
export type ReviewRequestPR = {
  /** "owner/name". */
  repo: string;
  url: string;
  title: string;
  number: number;
  isDraft: boolean;
  /**
   * Other reviewers' verdict so far. Not your own: a PR leaves the
   * review-requested queue as soon as you submit a review.
   */
  reviewDecision: ReviewDecision;
  createdAt: string;
  /** True when the PR carries the configured WIP label. */
  isWip: boolean;
  headRefName: string;
  /** Rolled-up state of the head commit's checks, or null when there are none. */
  ciState: CIState;
  /** The author's login — whoever is waiting on you. "" if the account is gone. */
  author: string;
  additions: number;
  deletions: number;
};

export type TeamRepoPRs = {
  repo: string;
  /** Total open PRs, all branches. */
  openCount: number;
  /** Open PRs carrying the WIP label (subset of openCount). */
  wipCount: number;
  /**
   * Open PRs with an approving review (subset of openCount).
   *
   * Overlaps `wipCount` in principle - an approved PR could still carry the WIP
   * label - which is why `toReviewCount` clamps rather than trusting the
   * subtraction.
   */
  approvedCount: number;
};

export type GitHubResponse = {
  viewer: string;
  myPRs: MyPR[];
  /**
   * Open PRs awaiting the viewer's review, oldest first, in the configured
   * repos only (the search carries `repo:` qualifiers).
   */
  reviewRequests: ReviewRequestPR[];
  /**
   * GitHub's exact count of PRs awaiting your review. Can exceed
   * `reviewRequests.length`, which is capped at one search page.
   */
  reviewRequestTotal: number;
  teamPRsByRepo: TeamRepoPRs[];
  /**
   * Configured repos GitHub couldn't find: misspelled in config.json, or not
   * visible to the token. Their counts read 0, so the panel names them.
   */
  unavailableRepos: string[];
  /** The resolved WIP label name used to compute wipCount (for building exclusion links). */
  wipLabel: string;
};

/**
 * A terminal running a Claude Code session.
 *
 * No window or tab index, deliberately: iTerm2 numbers windows by z-order, so an
 * index captured now points at a different terminal the moment you focus
 * something else. The tty is the stable handle, and focusing re-searches by it.
 */
export type ClaudeSession = {
  pid: number;
  /** Device path, e.g. "/dev/ttys001" — joins the process to its terminal. */
  tty: string;
  /** Absolute working directory, or "" when it couldn't be read. */
  cwd: string;
  /** `cwd` with the home directory collapsed to `~`. */
  path: string;
  /** Last segment of the cwd, e.g. "pitwall" or "forms-app@feature-x". */
  workspace: string;
  /** The terminal's own title, cleaned of its spinner and job suffix. */
  title: string;
  /** Claude is mid-task, per the spinner in the title. Never inverted to "idle". */
  isWorking: boolean;
  /** An iTerm2 session owns this tty, so it can be brought to the front. */
  canFocus: boolean;
};

/**
 * A tmux session Pitwall started for a PR.
 *
 * The counterpart to `ClaudeSession`, and the distinction matters: that one is
 * *discovered* in a terminal you opened, and can only be pointed at. This one is
 * *owned* — Pitwall created it, can reattach the dock to it, and can end it.
 *
 * Listed straight from tmux rather than from the process scan, so a session
 * whose Claude has exited still appears and can still be cleaned up.
 */
export type PitwallTerminalSession = {
  /** The tmux session name, e.g. "pitwall_Northwind-forms-app_1234". */
  sessionName: string;
  /** "owner/name", matching MyPR.repo. */
  repo: string;
  prNumber: number;
  /** When tmux created it, ISO 8601. */
  createdAt: string;
  /** A dock pane currently has it open. */
  attached: boolean;
  /**
   * The pane's working directory, for display only.
   *
   * It says where the session actually ended up, which is the honest answer to
   * "is there a worktree here" — a PR whose branch was already checked out
   * elsewhere reuses that directory. Never used to decide what to delete: the
   * pane can be `cd`'d anywhere, so removal resolves the path from
   * `git worktree list` instead.
   */
  cwd: string | null;
};

/**
 * A git worktree Pitwall created for a PR, and may therefore remove.
 *
 * Only ever the managed kind. A checkout that was merely *reused* — your main
 * clone, or one you made by hand — never becomes one of these, which is what
 * stops it reaching `git worktree remove`.
 *
 * Found independently of the tmux session, because either can outlive the
 * other: ending a session leaves the directory, and a worktree whose session
 * has gone would otherwise be invisible.
 */
export type PitwallWorktree = {
  /** "owner/name". */
  repo: string;
  prNumber: number;
  /** Absolute path, under `terminals.worktreeRoot`. */
  path: string;
  branch: string | null;
  /** Has uncommitted changes, so removal is refused unless forced. */
  dirty: boolean;
};

export type SessionsResponse = {
  sessions: ClaudeSession[];
  /**
   * Terminals Pitwall is hosting. Empty when terminals are off — the panel then
   * shows only the discovered half, as it did before they existed.
   */
  terminals: PitwallTerminalSession[];
  /**
   * Worktrees Pitwall created. Listed alongside rather than inside `terminals`
   * because a worktree outlives the session that made it.
   */
  worktrees: PitwallWorktree[];
  /**
   * Why the list is empty when it is — a missing iTerm2 or a non-macOS host is
   * not the same as having no sessions, and the panel says which.
   */
  unavailable?: string;
};

/**
 * The outcome of ending a terminal session, as reported back to the panel.
 *
 * `removedWorktree` and `blocked` are only ever set when removal was asked for.
 * A refusal is not a failure: the session still ended, so `killed` stays true
 * and `blocked` explains what was left behind.
 */
export type KillTerminalResponse = {
  killed: boolean;
  detail: string;
  removedWorktree?: string | null;
  blocked?: string | null;
};

/** The outcome of a focus request, as reported back to the panel. */
export type FocusResponse = { focused: boolean; detail: string };

export type SeverityCounts = {
  critical: number;
  high: number;
  moderate: number;
  low: number;
};

/** Open Dependabot (vulnerable-dependency) alerts for one repo. */
export type RepoSecurity = SeverityCounts & {
  /** "owner/name". */
  repo: string;
  owner: string;
  name: string;
  /**
   * Total open alerts (GitHub's exact totalCount). The per-severity buckets are
   * summed from at most the first 100 alert nodes, so on a repo with >100 open
   * alerts the buckets may undercount while `total` stays exact.
   */
  total: number;
};

export type SecurityResponse = {
  repos: RepoSecurity[];
  /** Sums across all configured repos. */
  totals: SeverityCounts & { total: number };
};

export type LinearTicket = {
  identifier: string;
  title: string;
  url: string;
  statusName: string;
  statusType: string;
  statusColor: string;
  /** Workflow-state position within its type — orders tickets by swim lane. */
  statusPosition: number;
  cycleNumber: number | null;
  isCurrentCycle: boolean;
  teamKey: string;
  /**
   * PRs linked to this issue by Linear's own GitHub integration, with the state
   * Linear already tracks. Authoritative: it captures links made by branch name,
   * magic word or by hand, and it knows which are still open.
   */
  prs: TicketPR[];
  /** Parent issue, if any — present even when the parent isn't assigned to you. */
  parent: TicketParent | null;
  /** Sub-issues in Linear, including ones assigned to other people. */
  childCount: number;
};

/** Whether a linked PR is still live. Merged and closed are both finished. */
export type TicketPRStatus = "open" | "merged" | "closed";

/** A pull request linked to a Linear issue. */
export type TicketPR = {
  url: string;
  /** "owner/name". */
  repo: string;
  number: number;
  status: TicketPRStatus;
  isDraft: boolean;
};

/** Enough of a parent issue to head a group and link to it. */
export type TicketParent = { identifier: string; title: string };

/** One ticket inside a family, and how far down the chain it sits. */
export type TicketGroupRow = {
  ticket: LinearTicket;
  /**
   * Rungs below the family's header: 0 is a direct child, 1 its child, and so
   * on. Capped by `MAX_TICKET_INDENT` for display only — a chain deeper than
   * that still lists every ticket, it just stops indenting further rather than
   * marching off the right of the panel.
   */
  depth: number;
};

/** Assigned tickets under one parent, or the ungrouped ones when parent is null. */
export type TicketGroup = {
  parent: TicketParent | null;
  /** The parent's own ticket, when it is assigned to the viewer too. */
  parentTicket: LinearTicket | null;
  tickets: TicketGroupRow[];
};

export type LinearStatusDiagnostic = {
  configured: string[];
  matched: string[];
  missing: string[];
};

/**
 * One in-flight workflow status and what is sitting in it.
 *
 * Read from Linear's own "started" category rather than named in `config.json`,
 * so renaming a status or adding one is a Linear change and nothing else. The
 * two hardcoded buckets this replaced could only ever show two named statuses,
 * leaving every other in-flight status (Blocked, say) invisible.
 */
export type StatusFlow = {
  id: string;
  name: string;
  /** Linear's own colour for the status, so the panel matches its UI. */
  color: string;
  count: number;
  points: number;
  /** The count hit the page cap, so it understates. Shown rather than hidden. */
  truncated: boolean;
};

export type CyclePoints = {
  number: number;
  isCurrent: boolean;
  startsAt: string;
  endsAt: string;
  /** Total scope points in the cycle (team-wide). */
  teamTotal: number;
  /** Completed scope points (team-wide). */
  teamCompleted: number;
  /** Points on issues assigned to the viewer in this cycle. */
  myTotal: number;
  /** Points the viewer completed in this cycle ("points I did"). */
  myCompleted: number;
};

export type LinearResponse = {
  viewer: { id: string; name: string; email: string };
  myTickets: LinearTicket[];
  /** Every in-flight status and its load, in Linear's own order. */
  statusFlow: StatusFlow[];
  teamKey: string;
  orgUrlKey: string;
  availableStatusNames: string[];
  /** Points for the current cycle and the two previous, newest first. */
  cyclePoints: CyclePoints[];
  /** False when the team has cycles turned off; the cycle panel and column hide. */
  cyclesEnabled: boolean;
  /** False when the team doesn't estimate; point totals hide. */
  estimatesEnabled: boolean;
  /** Every team key in the workspace, for recognising ticket ids in PRs. */
  teamKeys: string[];
};

export type ApiError = { error: string };

/**
 * What the browser sends to start work on a ticket. Identifiers only, like every
 * other write in this app: the branch name comes from Linear and the base branch
 * from GitHub, so nothing the page sends decides what gets created.
 */
export type StartWorkRequest = {
  /** A Linear identifier, e.g. "ENG-5800". Normalized client-side, re-checked on the server. */
  ticketId: string;
  /** "owner/name", and it must be in config.json. */
  repo: string;
};

/**
 * The outcome of starting work.
 *
 * Deliberately not a bare success flag. The three writes — branch/PR, assignment,
 * status — can each independently not happen, and for reasons that are normal
 * rather than broken: the PR already existed, the ticket was already yours, the
 * ticket was already past In Progress. `notes` carries those, and is not an error
 * list; `error` is the only thing that means nothing happened.
 */
export type StartWorkResponse = {
  started: boolean;
  ticket: { identifier: string; title: string; url: string } | null;
  /** The PR that now exists for this ticket, whether or not this call made it. */
  pr: { url: string; number: number; repo: string; branch: string } | null;
  /** True only when this call opened it; false when it was already there. */
  prCreated: boolean;
  assigned: boolean;
  statusMoved: boolean;
  /** Things worth saying that aren't failures. Shown under the result. */
  notes: string[];
  /** Set only when nothing was created. */
  error?: string;
};

/**
 * What the browser needs to open a terminal socket. The token is minted by the
 * sidecar at boot and handed out only by the server, so a page that can't reach
 * /api/terminal can't reach the sidecar either.
 */
export type TerminalHandshake = {
  enabled: boolean;
  wsUrl: string;
  token: string;
};

/**
 * Identifies the PR a terminal session belongs to. Sent on socket open.
 *
 * `branch`, not `headRefName`: that spelling belongs to GitHub's schema and stays
 * on `MyPR`, but by the time it is a socket parameter it is just a branch — and
 * the query string, `terminalSocketUrl` and `TerminalTarget` all already say
 * `branch`.
 */
export type TerminalSessionRequest = {
  /** "owner/name", matching MyPR.repo. */
  repo: string;
  prNumber: number;
  branch: string;
};

/**
 * A terminal the dashboard currently has open, as the dock and its panes see it.
 *
 * Distinct from `ClaudeSession`: that is a Claude Code process discovered in one
 * of your own iTerm2 windows, which Pitwall can only point at. This is a pane
 * Pitwall hosts and owns.
 *
 * A snapshot, not a reference into PR data — a dashboard refresh replaces every
 * `MyPR` object, and a pane keyed on one of those would remount and drop its
 * socket.
 */
export type OpenTerminal = {
  /** `terminalSessionKey(repo, prNumber)` — stable across refreshes. */
  key: string;
  repo: string;
  prNumber: number;
  branch: string;
  title: string;
};
