import { terminalSessionKey } from "./terminal";
import type {
  CheckSuiteConclusions,
  CIState,
  LinearTicket,
  MergeQueue,
  MergeStateStatus,
  MyPR,
  PitwallTerminalSession,
  PitwallWorktree,
  RepoSecurity,
  ReviewRequestPR,
  RollupContextCounts,
  TicketPR,
} from "@/types";

/**
 * Presentation logic pulled out of the components so it can be tested without a
 * DOM stack. The components keep the markup; the arithmetic and the branching
 * live here, matching the pure-and-tested convention the rest of lib/ follows.
 */

/**
 * Open items at or above this count are highlighted as a hotspot, unless
 * `hotspotThreshold` in config.json says otherwise. 10 suits a small team; on a
 * larger one "In Progress" would be red all the time.
 */
export const DEFAULT_HOTSPOT_THRESHOLD = 10;

/**
 * How much a count should draw the eye, as a text colour.
 *
 * One rule for every count on the Team tab: hotspots red, an empty column
 * dimmed so it recedes, everything else plain. Here rather than in the panel
 * because it was already written twice — once for the PR table and once for the
 * status cards — and two copies of a threshold rule drift.
 */
export function countEmphasisClass(
  count: number,
  threshold: number = DEFAULT_HOTSPOT_THRESHOLD,
): string {
  if (isHotspot(count, threshold)) return "text-accent-red";
  if (count === 0) return "text-text-dim";
  return "text-text-primary";
}

/**
 * A flow count, marked when it understates.
 *
 * The "+" is the only honest way to render a count that hit the page cap: it
 * says the real number is at least this, rather than presenting a partial as
 * exact. Here rather than in the card so the rule is testable without a DOM.
 */
export function formatFlowCount(count: number, truncated: boolean): string {
  return truncated ? `${count}+` : String(count);
}

/**
 * How far a ticket sits inside its family, as the attributes that draw it.
 *
 * One rule is already drawn by the family wrapper, so depth 1 adds a second and
 * anything deeper is plain offset — a border per rung stacks into a thicket at
 * this width. Returned as a pair rather than a class string because the offset
 * is computed, and Tailwind can't generate a class from a runtime value.
 */
export function ticketIndent(depth: number): {
  className: string;
  style?: { marginLeft: string };
} {
  const className = depth > 0 ? "space-y-1.5 border-l border-line pl-3" : "space-y-1.5";
  return depth > 1
    ? { className, style: { marginLeft: `${(depth - 1) * 0.75}rem` } }
    : { className };
}

/** Whether a repo's open-item count is high enough to flag as a hotspot. */
export function isHotspot(count: number, threshold: number = DEFAULT_HOTSPOT_THRESHOLD): boolean {
  return count >= threshold;
}

/**
 * PRs actually awaiting review: open, minus those flagged work-in-progress,
 * minus those already approved. Both exclusions are things nobody needs to look
 * at - a WIP PR isn't asking, and an approved one has had its answer - so
 * leaving either in made this the count of open PRs rather than the count worth
 * acting on.
 *
 * `approvedCount` is required rather than defaulted: a default would let a new
 * call site silently get the old two-argument meaning while this comment claimed
 * otherwise, and the compiler is the only thing that catches that.
 *
 * Clamped at zero: the counts come from separate GraphQL aggregates, so a racing
 * update could produce a negative, and an approved PR carrying the WIP label is
 * subtracted twice.
 */
export function toReviewCount(
  openCount: number,
  wipCount: number,
  approvedCount: number,
): number {
  return Math.max(0, openCount - wipCount - approvedCount);
}

/**
 * Orders repos worst-first. Positional weighting rather than a sum, so a single
 * critical outranks any number of lesser alerts — the way GitHub's own security
 * tab surfaces them. Weights exceed any realistic per-severity count.
 */
export function severityRank(r: RepoSecurity): number {
  return r.critical * 1_000_000 + r.high * 10_000 + r.moderate * 100 + r.low;
}

/** Meter fill percentage, clamped to 0-100 and safe when total is 0. */
export function meterPercent(value: number, total: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((value / total) * 100)));
}

export type Freshness = {
  /** The moment every source had succeeded by; null until they all have. */
  updatedAt: Date | null;
  /** A source has fallen two refresh cycles behind, or never loaded at all. */
  stalled: boolean;
};

/**
 * Judges how current the dashboard is from one timestamp per polled source.
 *
 * The oldest source wins, deliberately. The three panels poll independently, so
 * a single shared timestamp let any one success mask another source that had
 * been failing for hours — the header read "live" while a panel sat on an error.
 * Reporting the oldest means the header can never claim to be fresher than the
 * least current thing on screen.
 */
export function freshness(
  stamps: readonly (Date | null)[],
  intervalSeconds: number,
  now: Date,
): Freshness {
  const loaded = stamps.filter((s): s is Date => s !== null);

  // Nothing has arrived yet — the first load, not a failure.
  if (loaded.length === 0) return { updatedAt: null, stalled: false };

  // Some source has succeeded and another never has. There is no honest
  // "updated at" to show, and it is a failure rather than a slow first load.
  if (loaded.length < stamps.length) return { updatedAt: null, stalled: true };

  const oldest = loaded.reduce((a, b) => (a.getTime() <= b.getTime() ? a : b));
  const behindSeconds = (now.getTime() - oldest.getTime()) / 1000;
  return { updatedAt: oldest, stalled: behindSeconds > intervalSeconds * 2 };
}

/**
 * How long ago something happened, in the coarsest useful unit. A future
 * timestamp reads as "just now" rather than counting backwards — the header's
 * clock ticks once a second, so it can sit fractionally behind a fresh write.
 */
export function formatRelative(date: Date | null, now: Date): string {
  if (!date) return "never";
  const sec = Math.floor((now.getTime() - date.getTime()) / 1000);
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  // This dashboard is left running for days, so a stall over a weekend would
  // otherwise read as "58h ago".
  return `${Math.floor(hr / 24)}d ago`;
}

/** The refresh cadence, as shown in the header. */
export function formatInterval(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  return `${Math.round(seconds / 60)}m`;
}

/** A cycle's date range, in UTC — see the note in formatCycleRange. */
const CYCLE_DATE_FORMAT: Intl.DateTimeFormatOptions = {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
};

/**
 * A cycle's span as short dates. Read in UTC deliberately: Linear's cycle
 * bounds sit on midnight, so formatting in the local zone shifted the displayed
 * day for anyone behind UTC.
 */
export function formatCycleRange(startsAt: string, endsAt: string): string {
  if (!startsAt || !endsAt) return "";
  const start = new Date(startsAt).toLocaleDateString("en-US", CYCLE_DATE_FORMAT);
  const end = new Date(endsAt).toLocaleDateString("en-US", CYCLE_DATE_FORMAT);
  return `${start} – ${end}`;
}

/** One line describing the viewer's open PRs; categories with none are omitted. */
export function summarizeMyPRs(prs: MyPR[]): string {
  const total = prs.length;
  if (total === 0) return "no open PRs";
  const wip = prs.filter((p) => p.isWip).length;
  const approved = prs.filter((p) => p.reviewDecision === "APPROVED").length;
  const changes = prs.filter((p) => p.reviewDecision === "CHANGES_REQUESTED").length;
  const awaiting = prs.filter(
    (p) => p.reviewDecision === "REVIEW_REQUIRED" || p.reviewDecision === null,
  ).length;
  const parts = [`${total} open`];
  if (wip) parts.push(`${wip} wip`);
  if (approved) parts.push(`${approved} approved`);
  if (changes) parts.push(`${changes} changes requested`);
  if (awaiting) parts.push(`${awaiting} awaiting`);
  return parts.join(" · ");
}

/**
 * One line describing the viewer's assigned tickets. The current cycle is named
 * here rather than badged on every row, where it was the same value repeated.
 */
export function summarizeMyTickets(count: number, currentCycle?: number | null): string {
  if (count === 0) return "no assigned tickets";
  const base = `${count} assigned`;
  return currentCycle == null ? base : `${base} · cycle ${currentCycle}`;
}

export type BadgeKind = "green" | "yellow" | "red" | "neutral" | "blue";

/**
 * The header's freshness dot. Colour and label are decided together so the two
 * can't drift apart, and stalled is judged before not-loaded: a source that
 * never loaded while the others did is a failure, not a slow first paint.
 */
export function statusIndicator(state: {
  loading: boolean;
  updatedAt: Date | null;
  stalled: boolean;
}): { kind: BadgeKind; label: string } {
  if (state.loading) return { kind: "blue", label: "refreshing" };
  if (state.stalled) return { kind: "yellow", label: "auto-refresh may be stalled" };
  if (state.updatedAt === null) return { kind: "neutral", label: "not loaded yet" };
  return { kind: "green", label: "live" };
}

/**
 * The review-state badge for one of the viewer's PRs. Draft wins over review
 * state: a draft's decision is not yet meaningful. An unset decision means
 * nobody has reviewed, which reads as "awaiting".
 */
export function reviewBadge(pr: Pick<MyPR, "isDraft" | "reviewDecision">): {
  kind: BadgeKind;
  label: string;
} {
  if (pr.isDraft) return { kind: "neutral", label: "draft" };
  switch (pr.reviewDecision) {
    case "APPROVED":
      return { kind: "green", label: "approved" };
    case "CHANGES_REQUESTED":
      return { kind: "red", label: "changes" };
    default:
      return { kind: "yellow", label: "awaiting" };
  }
}

/**
 * Oldest first — a review queue is ordered by who has been waiting longest, and
 * the row that has sat for a week is the one worth seeing at the top.
 *
 * `createdAt` is the PR's own age, not the moment you were asked: the timeline
 * event carrying that is a per-PR query GitHub charges separately for, and PR age
 * is the better proxy anyway. Labelled "opened" in the UI rather than "waiting",
 * so it doesn't claim to be something it isn't.
 */
export function sortByOldestFirst<T extends { createdAt: string }>(
  items: readonly T[],
): T[] {
  return [...items].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );
}

/**
 * The age cell for a PR row: what it reads, and what hovering it says.
 *
 * Both derived from one parse, so the label and its tooltip can't disagree — and
 * pure, so the parse is testable without a DOM stack. Says "opened" rather than
 * "waiting" because `createdAt` is the PR's own age, not the moment you were
 * asked; an unparseable date is admitted to rather than rendered as "NaNd ago".
 */
export function openedAge(
  createdAt: string,
  now: Date,
): { label: string; detail: string } {
  const opened = new Date(createdAt);
  if (Number.isNaN(opened.getTime())) {
    return { label: "—", detail: "No open date" };
  }
  return {
    label: formatRelative(opened, now),
    detail: `Opened ${opened.toLocaleString()}`,
  };
}

/** A repo's bare name, for a list that spans repos: "Northwind/api" → "api". */
export function repoShortName(nameWithOwner: string): string {
  const slash = nameWithOwner.lastIndexOf("/");
  return slash === -1 ? nameWithOwner : nameWithOwner.slice(slash + 1);
}

/** The size of a review job, as a diff stat. U+2212 so the minus aligns with +. */
export function formatDiffSize(additions: number, deletions: number): string {
  const safe = (n: number) => (Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0);
  return `+${safe(additions)} −${safe(deletions)}`;
}

/**
 * The badge for a PR awaiting your review — and, in the common case, none at all.
 *
 * `reviewBadge` would stamp "awaiting" on every row here: a PR that requests your
 * review is by definition awaiting one, so the badge would carry no information.
 * Only a draft, a broken build, or *another* reviewer's verdict tells you
 * something the row didn't already say.
 *
 * One slot, most-blocking first — the same ordering rule as `mergeReadiness`,
 * since "approved by someone else" and "checks failed" are often both true and
 * the failure is what changes your decision.
 */
export function reviewRequestBadge(
  pr: Pick<ReviewRequestPR, "isDraft" | "reviewDecision" | "ciState">,
): { kind: BadgeKind; label: string; detail: string } | null {
  if (pr.isDraft) {
    return { kind: "neutral", label: "draft", detail: "Draft — not ready for review" };
  }
  if (pr.ciState === "FAILURE" || pr.ciState === "ERROR") {
    return { kind: "red", label: "checks failed", detail: "A check failed" };
  }
  switch (pr.reviewDecision) {
    case "CHANGES_REQUESTED":
      return {
        kind: "red",
        label: "changes",
        detail: "Another reviewer has requested changes",
      };
    case "APPROVED":
      return {
        kind: "green",
        label: "approved",
        detail: "Already approved by another reviewer — yours is still requested",
      };
  }
  // Below every verdict above, deliberately: nobody is blocked on a cancelled
  // run, so it only earns the slot when there is nothing else to say. It is
  // still worth saying — otherwise the row is blank while GitHub shows red.
  if (pr.ciState === "CANCELLED") {
    return {
      kind: "yellow",
      label: "checks cancelled",
      detail: "A check was cancelled before it reported — nothing failed",
    };
  }
  return null;
}

/**
 * One line describing what is waiting on your review. `total` is GitHub's exact
 * count: when it exceeds what was fetched, the line says so rather than
 * presenting one page as the whole queue.
 */
export function summarizeReviewRequests(
  prs: readonly ReviewRequestPR[],
  total: number,
): string {
  // A matched count with no rows is a gap, not a queue: GitHub's search index
  // disagrees with itself, and the review-requested search has been seen live
  // returning `issueCount: 1` alongside `nodes: []`, with the same query
  // moments later returning the PR. `total` alone rendered that as "1 waiting"
  // above an empty list - a review request with nothing to open and no way to
  // tell it from a real one. The same reading covers a node the token couldn't
  // resolve, which arrives as null and is dropped for the same reason. So it
  // uses the "N of M" form the capped case already uses: the count is kept
  // rather than thrown away, and the zero says the rows aren't there.
  if (prs.length === 0) {
    return total > 0 ? `0 of ${total} waiting` : "nothing waiting on you";
  }
  const shown = total > prs.length ? `${prs.length} of ${total} waiting` : `${prs.length} waiting`;
  const drafts = prs.filter((p) => p.isDraft).length;
  return drafts > 0 ? `${shown} · ${drafts} draft` : shown;
}

/** A GitHub pull request, as referenced from a Linear attachment or a PR url. */
export type PRRef = { repo: string; number: number; url: string };

const PR_URL = /^https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)(?:[/?#]|$)/;

/**
 * A PR reference from a url, or null if it isn't one. Linear issues also carry
 * Slack threads, Claude artifacts and plain links, so callers must filter.
 * The url is normalised, so the same PR keys consistently however it was linked.
 */
export function parsePRRef(url: string): PRRef | null {
  const m = PR_URL.exec(url);
  if (!m) return null;
  return {
    repo: m[1],
    number: Number(m[2]),
    url: `https://github.com/${m[1]}/pull/${m[2]}`,
  };
}

// Titles follow the [ENG-1234] convention, so brackets are required rather than
// matching any capitals-dash-digits — otherwise "Fix HTTP-2 handling" reads as a
// ticket. Branches are the fallback and may carry an author prefix
// ("alex/eng-5406-..."), so the id is matched as a path segment.
const TITLE_TICKET = /\[([A-Z][A-Z0-9]+-\d+)\]/g;
const BRANCH_TICKET = /(?:^|\/)([a-z]{2,}[a-z0-9]*-\d+)(?:-|$)/;

/**
 * Ticket ids a PR claims, from its title first and its branch as a fallback.
 * Used for PRs whose ticket isn't in the viewer's own list, where Linear's
 * attachments can't help. Empty for a PR with no ticket, which is legitimate.
 */
export function ticketIdsFromPR(
  pr: Pick<MyPR, "title" | "headRefName">,
  /**
   * Linear team keys known to be real (the configured team, plus the teams of
   * the viewer's tickets). With them, a title's bare `ENG-123: Subject` counts
   * too, and a branch only yields an id with one of these keys, in any case and
   * followed by `-`, `/` or the end. That is what stops `fix/http-2-handling`
   * reading as ticket HTTP-2. Without them, the older bracket-and-branch rules.
   */
  knownKeys: readonly string[] = [],
): string[] {
  const ids: string[] = [];
  for (const m of pr.title.matchAll(TITLE_TICKET)) ids.push(m[1].toUpperCase());
  const keys = keyAlternation(knownKeys);
  if (keys) {
    const bare = new RegExp(`(?<![A-Za-z0-9-])((?:${keys})-\\d+)(?![A-Za-z0-9])`, "gi");
    for (const m of pr.title.matchAll(bare)) ids.push(m[1].toUpperCase());
    const branch = new RegExp(`(?:^|[/_])((?:${keys})-\\d+)(?=$|[-/_])`, "i").exec(
      pr.headRefName ?? "",
    );
    if (branch) ids.push(branch[1].toUpperCase());
  } else {
    const branch = BRANCH_TICKET.exec(pr.headRefName ?? "");
    if (branch) ids.push(branch[1].toUpperCase());
  }
  return [...new Set(ids)];
}

/** Team keys as a regex alternation, keeping only ones that look like keys. */
function keyAlternation(knownKeys: readonly string[]): string {
  return [...new Set(knownKeys.map((k) => k.toUpperCase()))]
    .filter((k) => /^[A-Z][A-Z0-9]*$/.test(k))
    .join("|");
}

/**
 * Inverts Linear's attachments into a PR-keyed index. One PR can serve several
 * tickets and one ticket can have several PRs, so both sides are many-to-many.
 */
export function buildPRTicketIndex(
  tickets: Pick<LinearTicket, "identifier" | "prs">[],
): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const t of tickets) {
    for (const pr of t.prs ?? []) {
      const ref = parsePRRef(pr.url);
      if (!ref) continue;
      const existing = index.get(ref.url);
      if (existing) {
        if (!existing.includes(t.identifier)) existing.push(t.identifier);
      } else {
        index.set(ref.url, [t.identifier]);
      }
    }
  }
  return index;
}

/**
 * Every ticket a PR belongs to. Linear's own attachments come first because they
 * are authoritative — they capture links made by any means, not just the naming
 * convention — with title and branch filling in tickets Linear didn't return.
 */
export function ticketsForPR(
  pr: Pick<MyPR, "url" | "title" | "headRefName">,
  index: Map<string, string[]>,
  knownKeys: readonly string[] = [],
): string[] {
  const key = parsePRRef(pr.url)?.url ?? pr.url;
  return [...new Set([...(index.get(key) ?? []), ...ticketIdsFromPR(pr, knownKeys)])];
}

/** A Linear issue link for any id, including tickets not assigned to the viewer. */
export function linearIssueUrl(orgUrlKey: string, identifier: string): string {
  if (!orgUrlKey) return "";
  return `https://linear.app/${orgUrlKey}/issue/${identifier}`;
}

// Leading ticket refs only — "[ENG-1][ENG-2] " or "[ENG-1]: " — plus any dash or
// colon separating them from the real title.
const LEADING_TICKET_REFS = /^(?:\s*\[[A-Z][A-Z0-9]+-\d+\]\s*)+(?:[-–—:]\s*)?/;

/**
 * A PR title without its leading ticket refs, because the ticket badge beside it
 * already carries them. Titles here follow the "[ENG-1234] Subject" convention,
 * so the prefix is pure duplication — and on a PR closing two tickets it was
 * long enough to push the actual subject out of view.
 *
 * Only strips from the start: "Revert [ENG-5411] because..." keeps its ref, and
 * a title that is nothing but a ref is left alone rather than blanked.
 */
export function stripTicketPrefix(title: string, knownKeys: readonly string[] = []): string {
  let stripped = title.replace(LEADING_TICKET_REFS, "");
  // A team that writes "ENG-123: Subject" rather than brackets. Known keys only,
  // for the same reason as ticketIdsFromPR: "HTTP-2 support" keeps its prefix.
  const keys = keyAlternation(knownKeys);
  if (keys) {
    stripped = stripped.replace(
      new RegExp(`^(?:\\s*(?:${keys})-\\d+\\b[\\s,]*)+(?:[-–—:]\\s*)?`, "i"),
      "",
    );
  }
  stripped = stripped.trim();
  return stripped.length > 0 ? stripped : title;
}

/**
 * Caps a badge list so it can't crowd out the text beside it. One ticket here
 * had five linked PRs, which truncated its own title to "(..".
 */
export function splitBadges<T>(
  items: readonly T[],
  max: number,
): { shown: T[]; hidden: number } {
  return {
    shown: items.slice(0, max),
    hidden: Math.max(0, items.length - max),
  };
}

/**
 * Splits linked PRs into the ones that still need attention and a count of those
 * already finished. Linear keeps every PR it ever attached, so a ticket can carry
 * a dozen merged PRs — showing them all as equals implied far more live work than
 * existed.
 */
export function splitPRsByState(prs: readonly TicketPR[]): {
  open: TicketPR[];
  finished: number;
} {
  const open = prs.filter((p) => p.status === "open");
  return { open, finished: prs.length - open.length };
}

/**
 * The linkage context both tables need, derived in one place.
 *
 * Kept out of the components because they are markup only. Tolerates a missing
 * Linear response — when Linear is erroring, PR rows still resolve their tickets
 * from the title and branch, they just lose Linear's authoritative view.
 */
export function linkingContext(
  linear:
    | { myTickets: LinearTicket[]; orgUrlKey: string; teamKey?: string; teamKeys?: string[] }
    | undefined,
): { ticketIndex: Map<string, string[]>; orgUrlKey: string; ticketKeys: string[] } {
  return {
    ticketIndex: buildPRTicketIndex(linear?.myTickets ?? []),
    orgUrlKey: linear?.orgUrlKey ?? "",
    // Every workspace team Linear reported, plus the configured team and the
    // viewer's tickets' teams in case that list is missing: real keys, so a bare
    // "ENG-123" or a "feature/OPS-12-x" branch can be trusted.
    ticketKeys: [
      ...new Set(
        [
          ...(linear?.teamKeys ?? []),
          linear?.teamKey,
          ...(linear?.myTickets ?? []).map((t) => t.teamKey),
        ].filter((k): k is string => !!k),
      ),
    ],
  };
}

const MERGE_STATES: readonly MergeStateStatus[] = [
  "CLEAN",
  "HAS_HOOKS",
  "UNSTABLE",
  "BLOCKED",
  "BEHIND",
  "DIRTY",
  "UNKNOWN",
];

/** Narrows GitHub's mergeStateStatus, defaulting to UNKNOWN for anything new. */
export function toMergeStateStatus(raw: unknown): MergeStateStatus {
  return MERGE_STATES.includes(raw as MergeStateStatus)
    ? (raw as MergeStateStatus)
    : "UNKNOWN";
}

/** The merge queue's view of a PR, or null when it isn't in one. */
export function toMergeQueue(
  isInMergeQueue: unknown,
  entry: { state?: string | null; position?: number | null } | null | undefined,
): MergeQueue | null {
  if (isInMergeQueue !== true) return null;
  // Membership decides; the entry is only detail, and GitHub can return it
  // null while membership is true.
  return { state: entry?.state ?? null, position: entry?.position ?? null };
}

// GitHub's own StatusState values. "CANCELLED" is deliberately absent: it is a
// check-run conclusion, never a rollup state, and only ever reached below.
const CI_STATES: readonly string[] = [
  "SUCCESS",
  "PENDING",
  "FAILURE",
  "ERROR",
  "EXPECTED",
];

/**
 * Conclusions that mean something is actually broken. Anything else — skipped,
 * neutral, cancelled, stale — is not a failure, so the list is written as what
 * *does* fail: a conclusion GitHub adds later goes to the safe side.
 *
 * Check runs and check suites share one enum upstream, so both are read against
 * this list. Keeping it single also keeps them in step: a conclusion that counts
 * as broken for a job counts as broken for the run containing it.
 */
const FAILING_CHECK_RUNS: readonly string[] = [
  "FAILURE",
  "TIMED_OUT",
  "STARTUP_FAILURE",
  "ACTION_REQUIRED",
];

/**
 * Conclusions where the run stopped without judging the code. STALE joins
 * CANCELLED because neither is a verdict — GitHub marks a check stale when a
 * newer run supersedes it, which is the same story as a cancelled one.
 */
const ABANDONED_CHECK_RUNS: readonly string[] = ["CANCELLED", "STALE"];

/** Commit statuses (the older, non-Actions kind) that mean broken. */
const FAILING_STATUS_CONTEXTS: readonly string[] = ["FAILURE", "ERROR"];

function countIn(
  counts: Array<{ state?: string | null; count?: number | null }> | null | undefined,
  states: readonly string[],
): number {
  return (counts ?? []).reduce(
    (n, c) => (c?.state && states.includes(c.state) ? n + (c.count ?? 0) : n),
    0,
  );
}

/** What the commit's *live* runs concluded, once superseded ones are dropped. */
type LiveSuites = {
  /** Conclusions of the newest run of each workflow. Nulls are excluded. */
  conclusions: string[];
  /** A live Actions run hasn't finished, so "everything passed" isn't provable. */
  pending: boolean;
};

/**
 * The verdicts still standing, or `null` when they can't be trusted.
 *
 * Flattening every suite on the commit is not enough, because a commit keeps
 * the runs a re-run replaced. Re-running a workflow leaves its old suite
 * attached with whatever it concluded, so a run that failed and was then re-run
 * green would read as a live failure forever — the same mistake as the counts,
 * one level up. Suites are therefore grouped by the workflow that produced them
 * and only each group's newest run is read.
 *
 * Ties keep every conclusion sharing the newest timestamp rather than picking
 * one, so an ambiguous order can only ever add a verdict, never hide one.
 *
 * Two refusals, both because guessing in the trusting direction is the one guess
 * that clears a real failure: a page short of `totalCount` could be hiding the
 * failing suite past its end, and an absent `totalCount` leaves no way to tell a
 * short page from a whole one, since the page size lives in the query.
 */
function liveSuites(suites?: CheckSuiteConclusions | null): LiveSuites | null {
  const nodes = suites?.nodes;
  if (!nodes) return null;
  const total = suites?.totalCount;
  if (typeof total !== "number" || total > nodes.length) return null;

  const newestPerWorkflow = new Map<string, { at: string; nodes: typeof nodes }>();
  for (const n of nodes) {
    if (!n) continue;
    // Identity first, app second: a re-run shares the workflow of the run it
    // replaced, which is exactly the grouping that drops the superseded one.
    const key = n.workflowRun?.workflow?.id ?? `app:${n.app?.slug ?? ""}`;
    const at = n.createdAt ?? "";
    const group = newestPerWorkflow.get(key);
    if (!group || at > group.at) newestPerWorkflow.set(key, { at, nodes: [n] });
    else if (at === group.at) group.nodes.push(n);
  }

  const live = [...newestPerWorkflow.values()].flatMap((g) => g.nodes);
  return {
    conclusions: live.flatMap((n) => (typeof n?.conclusion === "string" ? [n.conclusion] : [])),
    // Only Actions runs count: an app's suite sits `QUEUED` indefinitely and
    // never concludes, so treating those as pending would mean no commit ever
    // qualified as finished.
    pending: live.some((n) => n?.workflowRun != null && n.status !== "COMPLETED"),
  };
}

/**
 * Narrows the check rollup, treating an absent rollup as "no checks".
 *
 * The rollup state alone over-reports failure: GitHub collapses a *cancelled*
 * run into `FAILURE`, so a job killed by a newer push looked identical to a
 * broken build. A red rollup is downgraded to `CANCELLED` only when the evidence
 * positively explains it — nothing failing, something abandoned. Anything less
 * certain stays red, because turning a real failure green is the worse mistake
 * and every field here is optional data an API can stop sending.
 *
 * `suites` is consulted before `contexts` because the counts cannot answer the
 * question on their own: they are summed across *every* suite on the commit, so
 * a job that failed in a run since superseded is tallied identically to one
 * failing now, and the red outlives the thing that caused it. A commit whose
 * jobs all re-ran green after a cancelled first attempt kept reporting
 * `FAILURE`, which is precisely the case this is here to catch. The suites say
 * which run each verdict belongs to; the counts only say how many there were.
 *
 * When every live run finished green the answer is `SUCCESS`, not `CANCELLED`:
 * there is nothing left to re-run, and saying so is what lets the badge read
 * "blocked on a required review" instead of implying work outstanding. That is
 * the strongest claim here, so it is the most heavily guarded — a complete suite
 * list, no failing commit status, no failing or abandoned live run, and nothing
 * still going.
 */
export function toCIState(
  raw: unknown,
  contexts?: RollupContextCounts | null,
  suites?: CheckSuiteConclusions | null,
): CIState {
  const state = CI_STATES.includes(raw as string) ? (raw as CIState) : null;
  if (state !== "FAILURE" && state !== "ERROR") return state;

  const runs = contexts?.checkRunCountsByState;
  const statuses = contexts?.statusContextCountsByState;

  // Commit statuses are the older, non-Actions kind and belong to no suite, so
  // the conclusions below can say nothing about them. A failing one is a real
  // failure however green the suites look.
  if (countIn(statuses, FAILING_STATUS_CONTEXTS) > 0) return state;

  const live = liveSuites(suites);
  if (live) {
    const { conclusions, pending } = live;
    if (conclusions.some((c) => FAILING_CHECK_RUNS.includes(c))) return state;
    if (conclusions.some((c) => ABANDONED_CHECK_RUNS.includes(c))) {
      // A live run stopped without judging — but "abandoned" is not the same as
      // "nothing failed", and only the counts can tell the difference. A matrix
      // that cancels its siblings the moment one shard fails concludes the run
      // CANCELLED with a real failure inside it, and a job failing in a run
      // still going is invisible up here, since its suite has no conclusion
      // yet. Either way the failure is counted, so a counted failure means the
      // red cannot be shown to be stale.
      return countIn(runs, FAILING_CHECK_RUNS) > 0 ? state : "CANCELLED";
    }
    if (!pending && conclusions.length > 0) return "SUCCESS";
  }

  // Absent counts need no guard of their own: `countIn` reads null and undefined
  // as zero, so both tests below fall through to the same red this would return.
  if (countIn(runs, FAILING_CHECK_RUNS) > 0) return state;
  if (countIn(runs, ABANDONED_CHECK_RUNS) > 0) return "CANCELLED";
  return state;
}

/** The badge for a PR sitting in a merge queue. */
function mergeQueueReadiness(q: MergeQueue): {
  kind: BadgeKind;
  label: string;
  detail: string;
} {
  if (q.state === "UNMERGEABLE") {
    return {
      kind: "red",
      label: "queue failed",
      detail: "The merge queue's checks failed — GitHub will eject it",
    };
  }
  // Every other entry state means the same thing to you: it's the queue's
  // problem now. Position is 1-based (a sole entry reports 1).
  const at = q.position ? ` at position ${q.position}` : "";
  return {
    kind: "yellow",
    label: "queued",
    detail: `In the merge queue${at} — not yours to merge`,
  };
}

/**
 * Whether the merge button is actually available, and if not, why.
 *
 * A review badge alone is misleading: an approved PR reads as ready when it may
 * have conflicts or a failed check. This answers the question you'd otherwise
 * open the PR to discover.
 *
 * Order matters — the most blocking reason wins, so a conflicted PR reports the
 * conflict rather than whatever else is also true. `null` means say nothing:
 * GitHub computes mergeability lazily, and a "?" on every freshly opened PR is
 * noise rather than information.
 */
export function mergeReadiness(
  pr: Pick<MyPR, "isDraft" | "mergeStateStatus" | "ciState" | "mergeQueue">,
): { kind: BadgeKind; label: string; detail: string } | null {
  if (pr.isDraft) {
    return { kind: "neutral", label: "draft", detail: "Draft — cannot be merged" };
  }
  // Conflicts outrank everything: nothing else can be acted on until the branch
  // merges cleanly again.
  if (pr.mergeStateStatus === "DIRTY") {
    return {
      kind: "red",
      label: "conflicts",
      detail: "Conflicts with the base branch — merge is blocked",
    };
  }
  // Above the CI checks on purpose: the queue re-runs them on its own
  // gh-readonly-queue branch against a different commit, so the rollup here
  // belongs to a run the queue has superseded.
  if (pr.mergeQueue) {
    return mergeQueueReadiness(pr.mergeQueue);
  }
  // A broken check outranks every remaining state. Being behind or blocked is
  // secondary to something actually failing, and reporting only "behind" hid it.
  if (pr.ciState === "FAILURE" || pr.ciState === "ERROR") {
    return { kind: "red", label: "checks failed", detail: "A check failed" };
  }
  // Same slot, one rung down: an abandoned run is the reason a PR looks red on
  // GitHub without anything having failed, and re-running it is the action — so
  // it still outranks "behind" and "blocked", which is usually what it caused.
  if (pr.ciState === "CANCELLED") {
    return {
      kind: "yellow",
      label: "checks cancelled",
      detail: "A check was cancelled before it reported — nothing failed, re-run it",
    };
  }
  switch (pr.mergeStateStatus) {
    case "UNSTABLE":
      // Only reachable with a rollup that isn't red — FAILURE, ERROR and
      // CANCELLED all returned above — so "a check is failing" was exactly what
      // this could not mean. UNSTABLE is GitHub's "mergeable, but not everything
      // came back green", which covers a run still going and one that reported
      // no verdict at all.
      if (pr.ciState === "PENDING" || pr.ciState === "EXPECTED") {
        return {
          kind: "yellow",
          label: "checks running",
          detail: "Mergeable — waiting on checks to finish",
        };
      }
      return {
        kind: "yellow",
        label: "checks incomplete",
        detail: "Mergeable, but not every check reported a pass",
      };
    case "BEHIND":
      return {
        kind: "yellow",
        label: "behind",
        detail: "Head is out of date with the base branch — update it first",
      };
    case "BLOCKED":
      // BLOCKED alone doesn't say what is blocking. The check rollup does: still
      // running means wait, already green means a reviewer is the holdup.
      if (pr.ciState === "PENDING" || pr.ciState === "EXPECTED") {
        return { kind: "yellow", label: "checks running", detail: "Waiting on checks" };
      }
      return {
        kind: "yellow",
        label: "blocked",
        // Only claim the checks passed when there were checks that passed —
        // toCIState maps an absent rollup to null, which proves nothing.
        detail:
          pr.ciState === "SUCCESS"
            ? "Checks pass — blocked on a required review"
            : "Blocked — a required review or check is outstanding",
      };
    case "CLEAN":
    case "HAS_HOOKS":
      return { kind: "green", label: "ready", detail: "Ready to merge" };
    default:
      // UNKNOWN: GitHub hasn't computed it yet. It resolves on the next refresh.
      return null;
  }
}

/** One identity in the header: which system it came from, and how to show it. */
export type ViewerIdentity = {
  source: "Linear" | "GitHub";
  /** The value to display, or null while that source hasn't answered. */
  value: string | null;
  /** Where it links, when it links anywhere. Linear has no profile URL here. */
  href: string | null;
};

/**
 * The header's two identities, prepared for rendering.
 *
 * Here rather than in the component because it is a derivation, not markup: the
 * two sources load independently, so either can be absent while the other is
 * present, and each needs its own placeholder rather than the pair collapsing
 * to one "Loading…". Building the profile URL is the other half — a string
 * concatenation is exactly the kind of thing that ends up untested inside JSX.
 */
export function viewerIdentities(
  linearName?: string,
  githubLogin?: string,
): ViewerIdentity[] {
  return [
    { source: "Linear", value: linearName || null, href: null },
    {
      source: "GitHub",
      value: githubLogin ? `@${githubLogin}` : null,
      href: githubLogin ? `https://github.com/${githubLogin}` : null,
    },
  ];
}

/**
 * The PR list as it goes on the clipboard: one URL per line.
 *
 * URLs alone, deliberately. The list is pasted into Slack or a standup note,
 * where a bare GitHub link unfurls into a card carrying the title and state
 * already — repeating them here would duplicate what the paste target renders,
 * and titles run long enough to wrap and bury the links.
 *
 * No trailing newline: pasting into a single-line field would otherwise submit
 * or leave a blank row.
 */
export function prListForClipboard(prs: readonly { url: string }[]): string {
  return prs.map((p) => p.url).join("\n");
}

/**
 * The copy-all button's label and accessible name.
 *
 * Counted rather than a bare "Copy all", so it says how much is about to land
 * on the clipboard — four links and forty are very different pastes. Kept here
 * with the other button strings so a screen reader's wording is covered by a
 * test rather than living only in markup.
 */
export function copyAllLabels(
  count: number,
  copied: boolean,
): { label: string; aria: string } {
  const plural = count === 1 ? "link" : "links";
  return copied
    ? { label: "Copied", aria: `Copied ${count} ${plural}` }
    : { label: `Copy ${count}`, aria: `Copy all ${count} ${plural} to the clipboard` };
}

/**
 * The copy button's accessible name and tooltip.
 *
 * Here rather than in the component so the strings a screen reader announces are
 * covered by a test — the component keeps the clipboard call and the timer, which
 * are browser concerns and can't be pure.
 */
export function copyButtonLabels(
  url: string,
  label: string,
  copied: boolean,
): { aria: string; title: string } {
  return copied
    ? { aria: `Copied ${label}`, title: "Copied" }
    : { aria: `Copy link to ${label}`, title: `Copy ${url}` };
}

/**
 * One PR's leftovers: its hosted terminal, its worktree, or both.
 *
 * `session` and `worktree` are independently nullable because either can outlive
 * the other — ending a session leaves the directory behind, and a worktree can
 * be removed while the session runs on.
 */
export type TerminalRow = {
  /** `terminalSessionKey(repo, prNumber)`. */
  key: string;
  repo: string;
  prNumber: number;
  /** The tmux session, or null when only a worktree is left. */
  session: PitwallTerminalSession | null;
  /** A worktree Pitwall created and may remove, or null. */
  worktree: PitwallWorktree | null;
  /**
   * The PR this was opened for, or null when it is no longer among your open
   * PRs — merged, closed, or reassigned.
   */
  pr: MyPR | null;
  /**
   * Whether the PR list was available to check against.
   *
   * False means GitHub couldn't be reached, not that the PR is finished. The
   * distinction matters because "pr closed" is the row's main hint that its
   * leftovers are safe to delete — a failed fetch labelling every live PR as
   * closed would be an invitation to remove a worktree you are still using.
   */
  prKnown: boolean;
};

/**
 * Pairs each hosted terminal and worktree with its PR, one row per PR.
 *
 * The dock needs a branch and a title to open a pane, and neither tmux nor git
 * knows either — a session name and a worktree directory carry only the repo and
 * the number. So a row can offer to open itself only while the PR is still in
 * your list; once it merges, the leftovers outlive the data needed to attach to
 * them.
 *
 * That case is why the pairing is explicit rather than a lookup at click time:
 * a row that cannot be opened has to *say* so, and a click whose only possible
 * outcome is nothing is worse than a disabled control.
 */
export function terminalRows(
  terminals: PitwallTerminalSession[],
  worktrees: PitwallWorktree[],
  /** Your open PRs, or null when GitHub couldn't be reached. */
  prs: MyPR[] | null,
): TerminalRow[] {
  // Paired case-insensitively: a PR carries GitHub's spelling of the repo and a
  // session or worktree carries config.json's, and a mismatch would label a live
  // PR "closed" - the row's main hint that deleting is safe.
  const prByKey = new Map(
    (prs ?? []).map((p) => [terminalSessionKey(p.repo, p.number).toLowerCase(), p] as const),
  );

  const rows = new Map<string, TerminalRow>();
  const rowFor = (repo: string, prNumber: number): TerminalRow => {
    const key = terminalSessionKey(repo, prNumber);
    const existing = rows.get(key);
    if (existing) return existing;
    const created: TerminalRow = {
      key,
      repo,
      prNumber,
      session: null,
      worktree: null,
      pr: prByKey.get(key.toLowerCase()) ?? null,
      prKnown: prs !== null,
    };
    rows.set(key, created);
    return created;
  };

  for (const t of terminals) rowFor(t.repo, t.prNumber).session = t;
  for (const w of worktrees) rowFor(w.repo, w.prNumber).worktree = w;

  // Sessions come back in tmux's order and worktrees in git's; neither is
  // meaningful to a reader, and a list that reshuffles between polls is worse
  // than one that is merely arbitrary.
  return [...rows.values()].sort(
    (a, b) => a.repo.localeCompare(b.repo) || a.prNumber - b.prNumber,
  );
}

/**
 * The count beside the hosted list's heading.
 *
 * Counts the two halves separately because a row is no longer necessarily a
 * tmux session: a worktree whose session has been ended is still a row, and
 * calling it a session would be wrong in exactly the case the list exists for.
 */
export function summarizeTerminalRows(rows: TerminalRow[]): string {
  if (rows.length === 0) return "none";
  const sessions = rows.filter((r) => r.session).length;
  const worktrees = rows.filter((r) => r.worktree).length;
  const parts: string[] = [];
  if (sessions) parts.push(`${sessions} tmux ${sessions === 1 ? "session" : "sessions"}`);
  if (worktrees) parts.push(`${worktrees} worktree${worktrees === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

/**
 * What a row should say about its worktree, and whether removal is on offer.
 *
 * The three cases are genuinely different and a reader has to be able to tell
 * them apart before clicking: one directory will be deleted, one belongs to you
 * and is only being reported, and one doesn't exist.
 */
export function worktreeNote(row: TerminalRow): {
  text: string;
  detail: string;
  /** Shown for information only — nothing here can be removed. */
  readOnly: boolean;
} {
  if (row.worktree) {
    return {
      text: row.worktree.path,
      detail: `Created by Pitwall${
        row.worktree.branch ? ` for ${row.worktree.branch}` : ""
      } — removable. The branch itself is kept.`,
      readOnly: false,
    };
  }
  if (row.session?.cwd) {
    // No worktree of ours, but the session is sitting somewhere — which means
    // it reused a checkout that already held the branch, very often your main
    // clone. Naming it is the difference between "nothing to clean up" and
    // "this is why there is nothing to clean up".
    return {
      text: `reused · ${row.session.cwd}`,
      detail:
        "Pitwall reused this directory rather than creating it, so it is left alone.",
      readOnly: true,
    };
  }
  return {
    text: "no worktree",
    detail: "Nothing on disk beyond the tmux session.",
    readOnly: true,
  };
}
