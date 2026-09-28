import { describe, expect, it } from "vitest";
import {
  DEFAULT_HOTSPOT_THRESHOLD,
  buildPRTicketIndex,
  copyAllLabels,
  copyButtonLabels,
  countEmphasisClass,
  formatCycleRange,
  formatFlowCount,
  formatDiffSize,
  formatInterval,
  formatRelative,
  freshness,
  isHotspot,
  linearIssueUrl,
  linkingContext,
  mergeReadiness,
  meterPercent,
  openedAge,
  parsePRRef,
  prListForClipboard,
  repoShortName,
  reviewBadge,
  reviewRequestBadge,
  severityRank,
  sortByOldestFirst,
  splitBadges,
  splitPRsByState,
  statusIndicator,
  stripTicketPrefix,
  summarizeMyPRs,
  summarizeMyTickets,
  summarizeReviewRequests,
  summarizeTerminalRows,
  terminalRows,
  worktreeNote,
  ticketIdsFromPR,
  ticketsForPR,
  toCIState,
  toMergeQueue,
  toMergeStateStatus,
  ticketIndent,
  toReviewCount,
  viewerIdentities,
} from "./view";
import type { LinearTicket, MyPR, PitwallTerminalSession, PitwallWorktree, RepoSecurity, ReviewRequestPR } from "@/types";

const pr = (over: Partial<MyPR> = {}): MyPR =>
  ({
    isWip: false,
    isDraft: false,
    reviewDecision: null,
    ...over,
  }) as MyPR;

const repo = (over: Partial<RepoSecurity> = {}): RepoSecurity => ({
  repo: "Northwind/billing-app",
  owner: "Northwind",
  name: "billing-app",
  total: 0,
  critical: 0,
  high: 0,
  moderate: 0,
  low: 0,
  ...over,
});

describe("isHotspot", () => {
  it("is true at the threshold and above", () => {
    expect(isHotspot(DEFAULT_HOTSPOT_THRESHOLD)).toBe(true);
    expect(isHotspot(DEFAULT_HOTSPOT_THRESHOLD + 1)).toBe(true);
  });

  it("is false below the threshold", () => {
    expect(isHotspot(DEFAULT_HOTSPOT_THRESHOLD - 1)).toBe(false);
    expect(isHotspot(0)).toBe(false);
  });
});

describe("toReviewCount", () => {
  it("subtracts WIP from open", () => {
    expect(toReviewCount(7, 2, 0)).toBe(5);
  });

  it("is zero when everything open is WIP", () => {
    expect(toReviewCount(3, 3, 0)).toBe(0);
  });

  it("clamps rather than going negative when the counts disagree", () => {
    // The two totals come from separate aggregates and can race.
    expect(toReviewCount(2, 5, 0)).toBe(0);
  });

  it("subtracts approved as well as WIP", () => {
    // 15 open, 5 wip, 2 already approved - 8 actually want a reviewer.
    expect(toReviewCount(15, 5, 2)).toBe(8);
  });

  it("leaves approved out only when there are none", () => {
    expect(toReviewCount(4, 0, 0)).toBe(4);
    expect(toReviewCount(4, 0, 4)).toBe(0);
  });

  it("clamps when an approved PR also carries the WIP label", () => {
    // Both counts include it, so the subtraction double-counts by one.
    expect(toReviewCount(1, 1, 1)).toBe(0);
  });
});

describe("severityRank", () => {
  it("ranks one critical above any pile of lesser alerts", () => {
    const oneCritical = repo({ critical: 1 });
    const manyLesser = repo({ high: 99, moderate: 99, low: 99 });
    expect(severityRank(oneCritical)).toBeGreaterThan(severityRank(manyLesser));
  });

  it("ranks one high above any number of moderates and lows", () => {
    expect(severityRank(repo({ high: 1 }))).toBeGreaterThan(
      severityRank(repo({ moderate: 99, low: 99 })),
    );
  });

  it("ranks one moderate above any number of lows", () => {
    expect(severityRank(repo({ moderate: 1 }))).toBeGreaterThan(
      severityRank(repo({ low: 99 })),
    );
  });

  it("is zero for a clean repo", () => {
    expect(severityRank(repo())).toBe(0);
  });

  it("sorts a realistic set worst-first", () => {
    const rows = [
      repo({ name: "low-only", low: 5 }),
      repo({ name: "critical", critical: 1, low: 1 }),
      repo({ name: "high", high: 3 }),
      repo({ name: "moderate", moderate: 7 }),
    ];
    expect(
      [...rows].sort((a, b) => severityRank(b) - severityRank(a)).map((r) => r.name),
    ).toEqual(["critical", "high", "moderate", "low-only"]);
  });
});

describe("meterPercent", () => {
  it("computes a rounded percentage", () => {
    expect(meterPercent(1, 3)).toBe(33);
    expect(meterPercent(2, 3)).toBe(67);
  });

  it("returns 0 rather than NaN or Infinity when total is 0", () => {
    expect(meterPercent(5, 0)).toBe(0);
    expect(meterPercent(0, 0)).toBe(0);
  });

  it("caps at 100 when the value exceeds the total", () => {
    expect(meterPercent(150, 100)).toBe(100);
  });

  it("floors at 0 for a negative value", () => {
    expect(meterPercent(-5, 100)).toBe(0);
  });

  it("guards against non-finite inputs", () => {
    expect(meterPercent(NaN, 10)).toBe(0);
    expect(meterPercent(10, NaN)).toBe(0);
    expect(meterPercent(Infinity, 10)).toBe(0);
  });

  it("handles the exact-full case", () => {
    expect(meterPercent(120, 120)).toBe(100);
  });
});

describe("reviewBadge", () => {
  it("shows draft regardless of review decision", () => {
    // A draft's review state isn't meaningful yet, so draft must win.
    expect(reviewBadge({ isDraft: true, reviewDecision: "APPROVED" })).toEqual({
      kind: "neutral",
      label: "draft",
    });
  });

  it("shows approved", () => {
    expect(reviewBadge({ isDraft: false, reviewDecision: "APPROVED" })).toEqual({
      kind: "green",
      label: "approved",
    });
  });

  it("shows changes requested in red", () => {
    expect(reviewBadge({ isDraft: false, reviewDecision: "CHANGES_REQUESTED" })).toEqual({
      kind: "red",
      label: "changes",
    });
  });

  it("treats an unset decision as awaiting review", () => {
    expect(reviewBadge({ isDraft: false, reviewDecision: null })).toEqual({
      kind: "yellow",
      label: "awaiting",
    });
  });

  it("treats REVIEW_REQUIRED as awaiting too", () => {
    expect(reviewBadge({ isDraft: false, reviewDecision: "REVIEW_REQUIRED" })).toEqual({
      kind: "yellow",
      label: "awaiting",
    });
  });
});

describe("freshness", () => {
  const INTERVAL = 300;
  const now = new Date("2026-07-25T12:00:00Z");
  const secondsAgo = (s: number) => new Date(now.getTime() - s * 1000);

  it("is not stalled before anything has loaded", () => {
    expect(freshness([null, null, null], INTERVAL, now)).toEqual({
      updatedAt: null,
      stalled: false,
    });
  });

  it("reports the oldest source as the moment everything was current", () => {
    const oldest = secondsAgo(120);
    expect(freshness([secondsAgo(10), oldest, secondsAgo(60)], INTERVAL, now)).toEqual({
      updatedAt: oldest,
      stalled: false,
    });
  });

  it("stalls once the oldest source has missed two refresh cycles", () => {
    const result = freshness(
      [secondsAgo(10), secondsAgo(INTERVAL * 2 + 1), secondsAgo(10)],
      INTERVAL,
      now,
    );
    expect(result.stalled).toBe(true);
  });

  it("does not stall exactly at two refresh cycles", () => {
    const result = freshness(
      [secondsAgo(10), secondsAgo(INTERVAL * 2), secondsAgo(10)],
      INTERVAL,
      now,
    );
    expect(result.stalled).toBe(false);
  });

  // The bug this function exists to prevent: three sources polled independently
  // used to share one timestamp, so any single success made the whole dashboard
  // look fresh while another source had been failing for hours.
  it("stalls when one source is hours behind and the others are current", () => {
    const stale = secondsAgo(6 * 60 * 60);
    const result = freshness([secondsAgo(5), stale, secondsAgo(5)], INTERVAL, now);
    expect(result).toEqual({ updatedAt: stale, stalled: true });
  });

  it("stalls when one source has never loaded but the others have", () => {
    expect(freshness([secondsAgo(5), null, secondsAgo(5)], INTERVAL, now)).toEqual({
      updatedAt: null,
      stalled: true,
    });
  });

  it("is not stalled when there are no sources to judge", () => {
    expect(freshness([], INTERVAL, now)).toEqual({ updatedAt: null, stalled: false });
  });
});

describe("formatRelative", () => {
  const now = new Date("2026-07-26T12:00:00Z");
  const ago = (s: number) => new Date(now.getTime() - s * 1000);

  it("reads never with no date", () => {
    expect(formatRelative(null, now)).toBe("never");
  });

  it("reads just now under five seconds", () => {
    expect(formatRelative(ago(0), now)).toBe("just now");
    expect(formatRelative(ago(4), now)).toBe("just now");
  });

  it("counts seconds up to a minute", () => {
    expect(formatRelative(ago(5), now)).toBe("5s ago");
    expect(formatRelative(ago(59), now)).toBe("59s ago");
  });

  it("counts minutes up to an hour", () => {
    expect(formatRelative(ago(60), now)).toBe("1m ago");
    expect(formatRelative(ago(59 * 60), now)).toBe("59m ago");
  });

  it("counts hours up to a day", () => {
    expect(formatRelative(ago(60 * 60), now)).toBe("1h ago");
    expect(formatRelative(ago(23 * 60 * 60), now)).toBe("23h ago");
  });

  // The dashboard is left running for days, so a stall over a weekend used to
  // read as "58h ago" rather than rolling over into days.
  it("rolls over into days", () => {
    expect(formatRelative(ago(24 * 60 * 60), now)).toBe("1d ago");
    expect(formatRelative(ago(58 * 60 * 60), now)).toBe("2d ago");
  });

  it("treats a future timestamp as just now rather than going negative", () => {
    expect(formatRelative(new Date(now.getTime() + 30_000), now)).toBe("just now");
  });
});

describe("formatInterval", () => {
  it("keeps sub-minute intervals in seconds", () => {
    expect(formatInterval(30)).toBe("30s");
    expect(formatInterval(59)).toBe("59s");
  });

  it("rounds to whole minutes above a minute", () => {
    expect(formatInterval(60)).toBe("1m");
    expect(formatInterval(300)).toBe("5m");
    expect(formatInterval(90)).toBe("2m");
  });
});

describe("statusIndicator", () => {
  const at = new Date("2026-07-26T12:00:00Z");

  it("shows refreshing while loading, whatever else is true", () => {
    expect(statusIndicator({ loading: true, updatedAt: at, stalled: true })).toEqual({
      kind: "blue",
      label: "refreshing",
    });
  });

  it("shows live when current", () => {
    expect(statusIndicator({ loading: false, updatedAt: at, stalled: false })).toEqual({
      kind: "green",
      label: "live",
    });
  });

  it("shows stalled ahead of not-loaded, so a partial failure isn't grey", () => {
    expect(
      statusIndicator({ loading: false, updatedAt: null, stalled: true }),
    ).toEqual({ kind: "yellow", label: "auto-refresh may be stalled" });
  });

  it("shows not loaded on a cold start", () => {
    expect(
      statusIndicator({ loading: false, updatedAt: null, stalled: false }),
    ).toEqual({ kind: "neutral", label: "not loaded yet" });
  });
});

describe("summarizeMyPRs", () => {
  it("says so when there is nothing open", () => {
    expect(summarizeMyPRs([])).toBe("no open PRs");
  });

  it("reports just the total when nothing is categorised", () => {
    expect(summarizeMyPRs([pr(), pr(), pr()])).toBe("3 open · 3 awaiting");
  });

  it("omits categories with no PRs in them", () => {
    expect(summarizeMyPRs([pr({ reviewDecision: "APPROVED" })])).toBe(
      "1 open · 1 approved",
    );
  });

  it("lists every category that applies", () => {
    const prs = [
      pr({ isWip: true }),
      pr({ reviewDecision: "APPROVED" }),
      pr({ reviewDecision: "CHANGES_REQUESTED" }),
      pr({ reviewDecision: "REVIEW_REQUIRED" }),
    ];
    expect(summarizeMyPRs(prs)).toBe(
      "4 open · 1 wip · 1 approved · 1 changes requested · 2 awaiting",
    );
  });
});

describe("summarizeMyTickets", () => {
  it("says so when nothing is assigned", () => {
    expect(summarizeMyTickets(0)).toBe("no assigned tickets");
  });

  it("counts assigned tickets", () => {
    expect(summarizeMyTickets(1)).toBe("1 assigned");
    expect(summarizeMyTickets(12)).toBe("12 assigned");
  });
});

describe("formatCycleRange", () => {
  it("formats a start and end as short dates", () => {
    expect(formatCycleRange("2026-07-01T00:00:00Z", "2026-07-14T23:59:59Z")).toBe(
      "Jul 1 – Jul 14",
    );
  });

  it("is empty when either bound is missing", () => {
    expect(formatCycleRange("", "2026-07-14T00:00:00Z")).toBe("");
    expect(formatCycleRange("2026-07-01T00:00:00Z", "")).toBe("");
  });

  // Rendered in UTC on purpose. Formatting in local time shifted the displayed
  // day for anyone behind UTC, because Linear's cycle bounds sit on midnight.
  it("reads the day in UTC, not the local zone", () => {
    expect(formatCycleRange("2026-07-01T00:00:00Z", "2026-07-01T00:00:00Z")).toBe(
      "Jul 1 – Jul 1",
    );
  });
});

describe("parsePRRef", () => {
  it("parses a GitHub PR url", () => {
    expect(parsePRRef("https://github.com/Northwind/billing-app/pull/3649")).toEqual({
      repo: "Northwind/billing-app",
      number: 3649,
      url: "https://github.com/Northwind/billing-app/pull/3649",
    });
  });

  it("ignores a trailing path or query", () => {
    expect(
      parsePRRef("https://github.com/Northwind/forms-app/pull/3725/files?w=1")?.number,
    ).toBe(3725);
  });

  it("rejects anything that isn't a PR url", () => {
    // Linear attaches Slack threads and Claude artifacts to issues too.
    expect(parsePRRef("https://northwind.slack.com/archives/C0000000000")).toBeNull();
    expect(parsePRRef("https://github.com/Northwind/billing-app/issues/12")).toBeNull();
    expect(parsePRRef("")).toBeNull();
  });
});

describe("ticketIdsFromPR, with known team keys", () => {
  const KEYS = ["ENG", "SOL"];

  it("reads a bare id from a title that doesn't use brackets", () => {
    expect(ticketIdsFromPR({ title: "ENG-1234: Fix login", headRefName: "x" }, KEYS)).toEqual([
      "ENG-1234",
    ]);
  });

  it("does not read HTTP-2 as a ticket from a title or a branch", () => {
    expect(
      ticketIdsFromPR({ title: "Fix HTTP-2 handling", headRefName: "fix/http-2-handling" }, KEYS),
    ).toEqual([]);
    expect(ticketIdsFromPR({ title: "x", headRefName: "renovate/node-22" }, KEYS)).toEqual([]);
  });

  it("reads branches Linear allows beyond its own lowercase form", () => {
    for (const headRefName of ["ENG-12/foo", "feature/ENG-12-x", "alex/eng-12-x", "eng-12"]) {
      expect(ticketIdsFromPR({ title: "x", headRefName }, KEYS)).toEqual(["ENG-12"]);
    }
  });

  it("reads other known teams' ids too", () => {
    expect(ticketIdsFromPR({ title: "x", headRefName: "alex/sol-7-thing" }, KEYS)).toEqual([
      "SOL-7",
    ]);
  });

  it("doesn't take an id out of the middle of a longer word", () => {
    expect(ticketIdsFromPR({ title: "XENG-12 and ENG-12x", headRefName: "y" }, KEYS)).toEqual([]);
  });
});

describe("stripTicketPrefix, with known team keys", () => {
  it("strips a bare leading id with its separator", () => {
    expect(stripTicketPrefix("ENG-12: Fix login", ["ENG"])).toBe("Fix login");
    expect(stripTicketPrefix("ENG-12 Fix login", ["ENG"])).toBe("Fix login");
    expect(stripTicketPrefix("ENG-12, ENG-13 - Fix login", ["ENG"])).toBe("Fix login");
  });

  it("leaves a prefix that isn't a known team alone", () => {
    expect(stripTicketPrefix("HTTP-2 support", ["ENG"])).toBe("HTTP-2 support");
  });
});

describe("ticketIdsFromPR", () => {
  it("reads a single id from the title", () => {
    expect(
      ticketIdsFromPR({
        title: "[ENG-5411] Drop the legacy reports table",
        headRefName: "eng-5411-drop-legacy-reports-table",
      }),
    ).toEqual(["ENG-5411"]);
  });

  // Real case: one PR closing two tickets at once.
  it("reads several ids from the title", () => {
    expect(
      ticketIdsFromPR({
        title: "[ENG-5403][ENG-5404] Login logic: harden safeReturnToPath",
        headRefName: "alex/eng-5403-login-safereturntopath-sso-logout",
      }),
    ).toEqual(["ENG-5403", "ENG-5404"]);
  });

  it("falls back to the branch when the title has no id", () => {
    expect(
      ticketIdsFromPR({
        title: "Associate login labels with inputs",
        headRefName: "alex/eng-5406-login-textinput-id-label-a11y",
      }),
    ).toEqual(["ENG-5406"]);
  });

  it("handles an author-prefixed branch", () => {
    expect(
      ticketIdsFromPR({ title: "no id here", headRefName: "alex/eng-5406-thing" }),
    ).toEqual(["ENG-5406"]);
  });

  it("deduplicates when title and branch agree", () => {
    expect(
      ticketIdsFromPR({ title: "[ENG-5411] x", headRefName: "eng-5411-x" }),
    ).toEqual(["ENG-5411"]);
  });

  it("returns nothing for a PR with no ticket", () => {
    // An open PR on an external repo — must render as "no ticket", not broken.
    expect(
      ticketIdsFromPR({
        title: "Modified code to work with sending topics",
        headRefName: "update-for-topics",
      }),
    ).toEqual([]);
  });

  it("does not invent ids from unrelated digits", () => {
    expect(
      ticketIdsFromPR({ title: "Bump next to 16.2.11", headRefName: "chore/bump-next" }),
    ).toEqual([]);
  });
});

describe("buildPRTicketIndex", () => {
  const t = (identifier: string, urls: string[]) =>
    ({
      identifier,
      prs: urls.map((url) => ({
        url,
        repo: "Northwind/x",
        number: 1,
        status: "open" as const,
        isDraft: false,
      })),
    }) as never;

  it("inverts ticket attachments into a PR-keyed index", () => {
    const index = buildPRTicketIndex([
      t("ENG-5411", ["https://github.com/Northwind/billing-app/pull/3650"]),
      t("ENG-5406", ["https://github.com/Northwind/forms-app/pull/3724"]),
    ]);
    expect(index.get("https://github.com/Northwind/billing-app/pull/3650")).toEqual([
      "ENG-5411",
    ]);
  });

  // Real case: one PR serving three tickets.
  it("collects every ticket that points at the same PR", () => {
    const url = "https://github.com/Northwind/forms-app/pull/3725";
    const index = buildPRTicketIndex([
      t("ENG-5403", [url]),
      t("ENG-5404", [url]),
      t("ENG-5402", ["https://github.com/Northwind/forms-app/pull/3724", url]),
    ]);
    expect(index.get(url)).toEqual(["ENG-5403", "ENG-5404", "ENG-5402"]);
  });

  it("skips attachments that aren't PR urls", () => {
    const index = buildPRTicketIndex([
      t("ENG-5300", ["https://northwind.slack.com/archives/C0000000000"]),
    ]);
    expect(index.size).toBe(0);
  });
});

describe("ticketsForPR", () => {
  const pr = (over: Partial<MyPR> = {}) =>
    ({
      url: "https://github.com/Northwind/billing-app/pull/3650",
      title: "[ENG-5411] Drop the legacy reports table",
      headRefName: "eng-5411-drop-legacy-reports-table",
      ...over,
    }) as MyPR;

  it("prefers Linear's own attachments, which are authoritative", () => {
    const index = new Map([[pr().url, ["ENG-9999"]]]);
    expect(ticketsForPR(pr(), index)).toEqual(["ENG-9999", "ENG-5411"]);
  });

  it("falls back to the title when Linear has no attachment", () => {
    // Happens when the ticket isn't assigned to the viewer.
    expect(ticketsForPR(pr(), new Map())).toEqual(["ENG-5411"]);
  });

  it("returns nothing when neither source knows", () => {
    expect(
      ticketsForPR(pr({ title: "chore: bump deps", headRefName: "chore/bump" }), new Map()),
    ).toEqual([]);
  });

  it("does not repeat an id present in both sources", () => {
    const index = new Map([[pr().url, ["ENG-5411"]]]);
    expect(ticketsForPR(pr(), index)).toEqual(["ENG-5411"]);
  });
});

describe("linearIssueUrl", () => {
  it("builds a link for any ticket id, assigned or not", () => {
    expect(linearIssueUrl("northwind", "ENG-5210")).toBe(
      "https://linear.app/northwind/issue/ENG-5210",
    );
  });

  it("is empty without an org key, so the caller can render plain text", () => {
    expect(linearIssueUrl("", "ENG-1")).toBe("");
  });
});

describe("stripTicketPrefix", () => {
  it("removes a single leading ticket ref, since the badge already shows it", () => {
    expect(stripTicketPrefix("[ENG-5411] Drop the legacy reports table")).toBe(
      "Drop the legacy reports table",
    );
  });

  // Real case: the title prefix was so long the actual title was invisible.
  it("removes several stacked refs", () => {
    expect(
      stripTicketPrefix("[ENG-5403][ENG-5404] Login logic: harden safeReturnToPath"),
    ).toBe("Login logic: harden safeReturnToPath");
  });

  it("tolerates spacing and separators between refs", () => {
    expect(stripTicketPrefix("[ENG-1] [ENG-2] – thing")).toBe("thing");
    expect(stripTicketPrefix("[ENG-1]: thing")).toBe("thing");
  });

  it("leaves a title with no prefix alone", () => {
    expect(stripTicketPrefix("Drop the legacy reports table")).toBe(
      "Drop the legacy reports table",
    );
  });

  it("only strips from the start, never mid-title", () => {
    expect(stripTicketPrefix("Revert [ENG-5411] because it broke prod")).toBe(
      "Revert [ENG-5411] because it broke prod",
    );
  });

  it("keeps the original when the ref is all there is", () => {
    // Better a redundant title than an empty row.
    expect(stripTicketPrefix("[ENG-5411]")).toBe("[ENG-5411]");
  });
});

describe("splitBadges", () => {
  it("shows everything when it fits", () => {
    expect(splitBadges(["a", "b"], 2)).toEqual({ shown: ["a", "b"], hidden: 0 });
  });

  // Real case: a ticket with five linked PRs truncated its own title to "(..".
  it("caps the list and reports the remainder", () => {
    expect(splitBadges(["a", "b", "c", "d", "e"], 2)).toEqual({
      shown: ["a", "b"],
      hidden: 3,
    });
  });

  it("handles an empty list", () => {
    expect(splitBadges([], 2)).toEqual({ shown: [], hidden: 0 });
  });
});

describe("summarizeMyTickets with a cycle", () => {
  it("names the current cycle once, instead of badging every row", () => {
    expect(summarizeMyTickets(19, 57)).toBe("19 assigned · cycle 57");
  });

  it("omits the cycle when there isn't one", () => {
    expect(summarizeMyTickets(19, null)).toBe("19 assigned");
    expect(summarizeMyTickets(19)).toBe("19 assigned");
  });

  it("still short-circuits on an empty list", () => {
    expect(summarizeMyTickets(0, 57)).toBe("no assigned tickets");
  });
});

describe("splitPRsByState", () => {
  const pr = (status: "open" | "merged" | "closed", number: number) => ({
    url: `https://github.com/Northwind/billing-app/pull/${number}`,
    repo: "Northwind/billing-app",
    number,
    status,
    isDraft: false,
  });

  // A ticket linking one open and one merged PR used to show both identically.
  it("separates the live PR from the finished one", () => {
    const result = splitPRsByState([pr("open", 3647), pr("merged", 3640)]);
    expect(result.open.map((p) => p.number)).toEqual([3647]);
    expect(result.finished).toBe(1);
  });

  // A ticket whose four PRs are all merged needs no attention.
  it("counts a ticket whose every PR has shipped", () => {
    const result = splitPRsByState([
      pr("merged", 3638),
      pr("merged", 3637),
      pr("merged", 3634),
      pr("merged", 3621),
    ]);
    expect(result.open).toEqual([]);
    expect(result.finished).toBe(4);
  });

  it("counts closed-unmerged as finished too", () => {
    expect(splitPRsByState([pr("closed", 1)]).finished).toBe(1);
  });

  it("handles a ticket with no linked PRs", () => {
    expect(splitPRsByState([])).toEqual({ open: [], finished: 0 });
  });
});

describe("linkingContext", () => {
  const ticket = (identifier: string, url: string) =>
    ({
      identifier,
      prs: [{ url, repo: "Northwind/x", number: 1, status: "open" as const, isDraft: false }],
    }) as never;

  it("derives the index and org key from the Linear response", () => {
    const url = "https://github.com/Northwind/billing-app/pull/3650";
    const ctx = linkingContext({
      myTickets: [ticket("ENG-5411", url)],
      orgUrlKey: "northwind",
    });
    expect(ctx.orgUrlKey).toBe("northwind");
    expect(ctx.ticketIndex.get(url)).toEqual(["ENG-5411"]);
  });

  it("degrades to an empty context when Linear is unavailable", () => {
    // PR rows then fall back to title and branch parsing rather than breaking.
    const ctx = linkingContext(undefined);
    expect(ctx.orgUrlKey).toBe("");
    expect(ctx.ticketIndex.size).toBe(0);
  });
});

describe("mergeReadiness", () => {
  const pr = (over: Partial<MyPR> = {}) =>
    ({ isDraft: false, mergeStateStatus: "CLEAN", ciState: "SUCCESS", ...over }) as MyPR;

  it("says ready when the merge button is actually available", () => {
    expect(mergeReadiness(pr())).toMatchObject({ kind: "green", label: "ready" });
    expect(mergeReadiness(pr({ mergeStateStatus: "HAS_HOOKS" }))).toMatchObject({
      kind: "green",
      label: "ready",
    });
  });

  // The case that keeps catching people out: approved, so it reads as ready, but
  // conflicted, so the merge button is disabled.
  it("reports conflicts, whatever the review says", () => {
    expect(mergeReadiness(pr({ mergeStateStatus: "DIRTY" }))).toMatchObject({
      kind: "red",
      label: "conflicts",
    });
  });

  // UNSTABLE used to print "checks failed" flat, which it can never mean here:
  // a genuinely failing rollup returns above this branch, so every PR reaching
  // it was being called broken on the strength of a check that hadn't failed.
  it("does not call an UNSTABLE PR failed when nothing failed", () => {
    expect(mergeReadiness(pr({ mergeStateStatus: "UNSTABLE" }))).toMatchObject({
      kind: "yellow",
      label: "checks incomplete",
    });
    expect(
      mergeReadiness(pr({ mergeStateStatus: "UNSTABLE", ciState: "PENDING" })),
    ).toMatchObject({ kind: "yellow", label: "checks running" });
  });

  it("still reports a failing check on an otherwise mergeable PR", () => {
    expect(
      mergeReadiness(pr({ mergeStateStatus: "UNSTABLE", ciState: "FAILURE" })),
    ).toMatchObject({ kind: "red", label: "checks failed" });
  });

  it("reports being behind the base branch", () => {
    expect(mergeReadiness(pr({ mergeStateStatus: "BEHIND" }))).toMatchObject({
      kind: "yellow",
      label: "behind",
    });
  });

  // BLOCKED alone doesn't say why; the check rollup separates "wait" from "chase".
  it("distinguishes checks still running from a reviewer being the holdup", () => {
    expect(
      mergeReadiness(pr({ mergeStateStatus: "BLOCKED", ciState: "PENDING" })),
    ).toMatchObject({ label: "checks running" });
    expect(
      mergeReadiness(pr({ mergeStateStatus: "BLOCKED", ciState: "EXPECTED" })),
    ).toMatchObject({ label: "checks running" });
    expect(
      mergeReadiness(pr({ mergeStateStatus: "BLOCKED", ciState: "SUCCESS" })),
    ).toMatchObject({ label: "blocked" });
  });

  it("reports a failed required check rather than a vague block", () => {
    expect(
      mergeReadiness(pr({ mergeStateStatus: "BLOCKED", ciState: "FAILURE" })),
    ).toMatchObject({ kind: "red", label: "checks failed" });
    expect(
      mergeReadiness(pr({ mergeStateStatus: "BLOCKED", ciState: "ERROR" })),
    ).toMatchObject({ kind: "red", label: "checks failed" });
  });

  it("says draft before anything else, since a draft can never merge", () => {
    expect(
      mergeReadiness(pr({ isDraft: true, mergeStateStatus: "DIRTY" })),
    ).toMatchObject({ kind: "neutral", label: "draft" });
  });

  // GitHub computes mergeability lazily, so a freshly opened PR reads UNKNOWN.
  // Showing nothing beats showing a "?" that resolves itself minutes later.
  it("says nothing while GitHub hasn't computed mergeability", () => {
    expect(mergeReadiness(pr({ mergeStateStatus: "UNKNOWN" }))).toBeNull();
  });

  it("carries a detail string for the tooltip", () => {
    expect(mergeReadiness(pr({ mergeStateStatus: "DIRTY" }))?.detail).toContain(
      "Conflicts",
    );
  });
});

describe("toMergeStateStatus / toCIState", () => {
  it("passes through the states GitHub documents", () => {
    expect(toMergeStateStatus("CLEAN")).toBe("CLEAN");
    expect(toCIState("PENDING")).toBe("PENDING");
  });

  it("falls back to UNKNOWN for an unrecognised merge state", () => {
    // A new enum value shouldn't render a bogus badge.
    expect(toMergeStateStatus("SOMETHING_NEW")).toBe("UNKNOWN");
    expect(toMergeStateStatus(null)).toBe("UNKNOWN");
    expect(toMergeStateStatus(undefined)).toBe("UNKNOWN");
  });

  it("treats an absent check rollup as no checks", () => {
    expect(toCIState(null)).toBeNull();
    expect(toCIState(undefined)).toBeNull();
    expect(toCIState("NOT_A_STATE")).toBeNull();
  });

  // The counts below are the shape GitHub actually returns for a real PR:
  // 28 passed, 2 skipped, one job cancelled, nothing failed — rolled up FAILURE.
  const counts = (runs: Record<string, number>, statuses: Record<string, number> = {}) => ({
    checkRunCountsByState: Object.entries(runs).map(([state, count]) => ({ state, count })),
    statusContextCountsByState: Object.entries(statuses).map(([state, count]) => ({
      state,
      count,
    })),
  });

  it("calls a red rollup cancelled when a run was abandoned and none failed", () => {
    expect(
      toCIState("FAILURE", counts({ SUCCESS: 28, SKIPPED: 2, CANCELLED: 1 }, { SUCCESS: 1 })),
    ).toBe("CANCELLED");
    // STALE is the same story — superseded, not judged.
    expect(toCIState("FAILURE", counts({ SUCCESS: 3, STALE: 1 }))).toBe("CANCELLED");
  });

  it("leaves a real failure red even when a run was also cancelled", () => {
    expect(toCIState("FAILURE", counts({ SUCCESS: 20, FAILURE: 1, CANCELLED: 1 }))).toBe(
      "FAILURE",
    );
    expect(toCIState("FAILURE", counts({ SUCCESS: 20, TIMED_OUT: 1, CANCELLED: 1 }))).toBe(
      "FAILURE",
    );
    expect(
      toCIState("FAILURE", counts({ SUCCESS: 20, ACTION_REQUIRED: 1, CANCELLED: 1 })),
    ).toBe("FAILURE");
  });

  // A failing commit status is invisible in the check-run counts, so reading
  // only those would turn an old-style red build green.
  it("leaves a failing commit status red despite a cancelled check run", () => {
    expect(toCIState("FAILURE", counts({ SUCCESS: 5, CANCELLED: 1 }, { FAILURE: 1 }))).toBe(
      "FAILURE",
    );
    expect(toCIState("ERROR", counts({ SUCCESS: 5, CANCELLED: 1 }, { ERROR: 1 }))).toBe(
      "ERROR",
    );
  });

  it("stays red when the counts can't explain why", () => {
    // Counts absent, or present and unrevealing: guessing green would hide a
    // real failure, so the rollup's own word stands.
    expect(toCIState("FAILURE", null)).toBe("FAILURE");
    expect(toCIState("FAILURE", {})).toBe("FAILURE");
    expect(toCIState("FAILURE", counts({ SUCCESS: 4 }))).toBe("FAILURE");
  });

  it("leaves a rollup that isn't red alone", () => {
    // Skipped runs never needed rescuing — GitHub already rolls them up green.
    expect(toCIState("SUCCESS", counts({ SUCCESS: 28, SKIPPED: 2 }))).toBe("SUCCESS");
    expect(toCIState("PENDING", counts({ SUCCESS: 1, CANCELLED: 1 }))).toBe("PENDING");
  });

  // One check suite, as GitHub returns it. `wf` is the workflow that produced
  // the run: re-runs share it with the run they replace, which is what lets the
  // newer one supersede the older. `wf: null` is an app's suite (CodeRabbit,
  // Claude), which has no workflow at all.
  const suite = (
    conclusion: string | null,
    opts: { wf?: string | null; at?: string; status?: string; app?: string } = {},
  ) => {
    const { wf = "pull-request", at = "2026-08-07T19:00:00Z", status = "COMPLETED" } = opts;
    return {
      conclusion,
      status,
      createdAt: at,
      app: { slug: opts.app ?? (wf === null ? "coderabbitai" : "github-actions") },
      workflowRun: wf === null ? null : { workflow: { id: wf } },
    };
  };

  const suites = (
    nodes: ReturnType<typeof suite>[],
    totalCount: number | null = nodes.length,
  ) => ({ totalCount, nodes });

  // A real PR, exactly. The `wip` label went on, the WIP gate ran to
  // completion and failed, the label came off 14 minutes later and every job
  // re-ran green. The dead run's failure is still counted commit-wide, so the
  // counts alone report FAILURE for a PR with nothing left to fix — which is
  // what put a red badge on it. Nothing is outstanding, so it reads green.
  it("clears a red left behind by a superseded run", () => {
    expect(
      toCIState(
        "FAILURE",
        counts({ SUCCESS: 29, SKIPPED: 7, FAILURE: 1, CANCELLED: 1 }),
        suites([
          suite("CANCELLED", { at: "2026-08-07T18:59:59Z" }),
          suite("SUCCESS", { at: "2026-08-07T19:03:03Z" }),
        ]),
      ),
    ).toBe("SUCCESS");
  });

  // The same trap one level up: a suite that itself concluded FAILURE is not a
  // live verdict once a later run of that workflow passed. Reading conclusions
  // without grouping kept these red forever.
  it("does not keep a workflow red once a later run of it passed", () => {
    expect(
      toCIState(
        "FAILURE",
        counts({ SUCCESS: 20, FAILURE: 1 }),
        suites([
          suite("FAILURE", { at: "2026-08-07T10:00:00Z" }),
          suite("SUCCESS", { at: "2026-08-07T11:00:00Z" }),
        ]),
      ),
    ).toBe("SUCCESS");
  });

  it("goes red when the newer run of a workflow is the failing one", () => {
    expect(
      toCIState(
        "FAILURE",
        counts({ SUCCESS: 20, FAILURE: 1 }),
        suites([
          suite("SUCCESS", { at: "2026-08-07T10:00:00Z" }),
          suite("FAILURE", { at: "2026-08-07T11:00:00Z" }),
        ]),
      ),
    ).toBe("FAILURE");
  });

  // Two workflows: Label WIP passed after Pull Request failed, but they are
  // different workflows — one can't supersede the other. Taking the newest suite
  // overall rather than the newest *per workflow* would clear a real failure.
  it("does not let one workflow's newer run supersede another's failure", () => {
    expect(
      toCIState(
        "FAILURE",
        counts({ SUCCESS: 20, FAILURE: 1 }),
        suites([
          suite("FAILURE", { wf: "pull-request", at: "2026-08-07T10:00:00Z" }),
          suite("SUCCESS", { wf: "label-wip", at: "2026-08-07T11:00:00Z" }),
        ]),
      ),
    ).toBe("FAILURE");
  });

  it("keeps every verdict when two runs of a workflow share a timestamp", () => {
    // Picking one of a tie could hide the failure, so both are kept.
    expect(
      toCIState(
        "FAILURE",
        counts({ SUCCESS: 20, FAILURE: 1 }),
        suites([
          suite("SUCCESS", { at: "2026-08-07T10:00:00Z" }),
          suite("FAILURE", { at: "2026-08-07T10:00:00Z" }),
        ]),
      ),
    ).toBe("FAILURE");
  });

  it("trusts a failed suite even when no counted run failed", () => {
    // A run can fail without any check run recording it — a startup failure
    // never gets as far as producing one — so the tally looks merely cancelled.
    expect(
      toCIState("FAILURE", counts({ SUCCESS: 5, CANCELLED: 1 }), suites([suite("STARTUP_FAILURE")])),
    ).toBe("FAILURE");
  });

  it("reports a live run that was abandoned and never replaced as cancelled", () => {
    expect(
      toCIState("FAILURE", counts({ SUCCESS: 20, CANCELLED: 1 }), suites([suite("CANCELLED")])),
    ).toBe("CANCELLED");
  });

  it("stays red when the abandoned run has a counted failure inside it", () => {
    // Fail-fast: one shard fails, the matrix cancels its siblings, and the run
    // concludes CANCELLED with a genuine failure in it. Nothing superseded it,
    // so "nothing failed, re-run it" would be a false all-clear on a PR whose
    // tests are broken — and re-running just reproduces the failure.
    expect(
      toCIState(
        "FAILURE",
        counts({ SUCCESS: 12, FAILURE: 1, CANCELLED: 8 }),
        suites([suite("CANCELLED")]),
      ),
    ).toBe("FAILURE");
  });

  it("stays red when a job fails in a run that is still going", () => {
    // An unconcluded suite contributes no conclusion, so the failure is visible
    // only in the counts. Reading the cancelled sibling alone would clear it.
    expect(
      toCIState(
        "FAILURE",
        counts({ SUCCESS: 12, FAILURE: 1, CANCELLED: 1, IN_PROGRESS: 9 }),
        suites([
          suite("CANCELLED", { wf: "pull-request", at: "2026-08-07T10:00:00Z" }),
          suite(null, { wf: "retry", status: "IN_PROGRESS" }),
        ]),
      ),
    ).toBe("FAILURE");
  });

  it("will not call a commit green while one of its workflows is still going", () => {
    expect(
      toCIState(
        "FAILURE",
        counts({ SUCCESS: 20, FAILURE: 1 }),
        suites([
          suite("SUCCESS", { wf: "pull-request" }),
          suite(null, { wf: "image-build", status: "WAITING" }),
        ]),
      ),
    ).toBe("FAILURE");
  });

  it("is not held pending by an app suite that never concludes", () => {
    // CodeRabbit and Claude attach a suite that sits QUEUED indefinitely.
    // Counting those as in-flight would mean no commit ever qualified as done.
    expect(
      toCIState(
        "FAILURE",
        counts({ SUCCESS: 20, FAILURE: 1 }),
        suites([
          suite("SUCCESS", { wf: "pull-request" }),
          suite(null, { wf: null, status: "QUEUED" }),
        ]),
      ),
    ).toBe("SUCCESS");
  });

  it("refuses a truncated suite page rather than reading it as nothing failed", () => {
    // The failing suite could be past the end of what we asked for, so a short
    // page is thrown away and the commit-wide counts get the last word. The
    // pair matters: on this page the superseded run would otherwise clear a
    // failure that is real but out of sight.
    const tally = counts({ SUCCESS: 9, FAILURE: 1, CANCELLED: 1 });
    const page = [
      suite("CANCELLED", { at: "2026-08-07T10:00:00Z" }),
      suite("SUCCESS", { at: "2026-08-07T11:00:00Z" }),
    ];
    expect(toCIState("FAILURE", tally, suites(page, 51))).toBe("FAILURE");
    // Same page, now known to be the whole list — the superseded case, cleared.
    expect(toCIState("FAILURE", tally, suites(page))).toBe("SUCCESS");
    // And with no count at all there is nothing to prove completeness *with*:
    // the page size lives in the query, so an absent total is refused too.
    expect(toCIState("FAILURE", tally, suites(page, null))).toBe("FAILURE");
    expect(toCIState("FAILURE", tally, { nodes: page })).toBe("FAILURE");
  });

  it("ignores suites that haven't concluded", () => {
    // A suite still running has judged nothing, so it can neither condemn nor
    // clear the commit; with no concluded suite to go on, the counts decide.
    expect(
      toCIState(
        "FAILURE",
        counts({ SUCCESS: 3, FAILURE: 1 }),
        suites([
          suite(null, { wf: "a", status: "IN_PROGRESS" }),
          suite(null, { wf: "b", status: "QUEUED" }),
        ]),
      ),
    ).toBe("FAILURE");
  });

  it("keeps a failing commit status red however green the suites are", () => {
    // Commit statuses are the older, non-Actions kind and belong to no suite,
    // so an all-green suite list says nothing at all about them.
    expect(
      toCIState("FAILURE", counts({ SUCCESS: 5 }, { FAILURE: 1 }), suites([suite("SUCCESS")])),
    ).toBe("FAILURE");
  });

  it("falls back to the counts when the suites are missing", () => {
    // Every field is optional data GitHub could stop sending; losing it must
    // restore the old behaviour rather than clear a real failure.
    expect(toCIState("FAILURE", counts({ SUCCESS: 3, CANCELLED: 1 }), null)).toBe("CANCELLED");
    expect(toCIState("FAILURE", counts({ SUCCESS: 3, FAILURE: 1 }), undefined)).toBe("FAILURE");
    expect(toCIState("FAILURE", counts({ SUCCESS: 3, FAILURE: 1 }), {})).toBe("FAILURE");
  });

  it("leaves a rollup that isn't red alone whatever the suites say", () => {
    expect(toCIState("SUCCESS", counts({ SUCCESS: 4 }), suites([suite("FAILURE")]))).toBe(
      "SUCCESS",
    );
  });
});

describe("mergeReadiness precedence and honesty", () => {
  const pr = (over: Partial<MyPR> = {}) =>
    ({ isDraft: false, mergeStateStatus: "CLEAN", ciState: "SUCCESS", ...over }) as MyPR;

  // "Most blocking condition wins" — a failed check outranks being out of date,
  // and reporting only "behind" hid the failure entirely.
  it("reports a failed check ahead of being behind the base", () => {
    expect(
      mergeReadiness(pr({ mergeStateStatus: "BEHIND", ciState: "FAILURE" })),
    ).toMatchObject({ kind: "red", label: "checks failed" });
    expect(
      mergeReadiness(pr({ mergeStateStatus: "BEHIND", ciState: "ERROR" })),
    ).toMatchObject({ kind: "red", label: "checks failed" });
  });

  it("still reports behind when the checks are fine", () => {
    expect(
      mergeReadiness(pr({ mergeStateStatus: "BEHIND", ciState: "SUCCESS" })),
    ).toMatchObject({ label: "behind" });
  });

  // The row this shipped for: every check that finished passed, one job was
  // cancelled, and the PR was badged red "checks failed" with nothing to fix.
  it("reports a cancelled check as yellow, ahead of behind and blocked", () => {
    expect(
      mergeReadiness(pr({ mergeStateStatus: "BLOCKED", ciState: "CANCELLED" })),
    ).toMatchObject({ kind: "yellow", label: "checks cancelled" });
    expect(
      mergeReadiness(pr({ mergeStateStatus: "BEHIND", ciState: "CANCELLED" })),
    ).toMatchObject({ kind: "yellow", label: "checks cancelled" });
  });

  it("keeps a real failure and a conflict ahead of a cancelled check", () => {
    expect(
      mergeReadiness(pr({ mergeStateStatus: "UNSTABLE", ciState: "FAILURE" }))?.label,
    ).toBe("checks failed");
    expect(
      mergeReadiness(pr({ mergeStateStatus: "DIRTY", ciState: "CANCELLED" }))?.label,
    ).toBe("conflicts");
    expect(mergeReadiness(pr({ isDraft: true, ciState: "CANCELLED" }))?.label).toBe("draft");
  });

  it("keeps conflicts ahead of a failed check", () => {
    // Both block, but the conflict is the thing you must fix first.
    expect(
      mergeReadiness(pr({ mergeStateStatus: "DIRTY", ciState: "FAILURE" })),
    ).toMatchObject({ label: "conflicts" });
  });

  // toCIState maps an absent rollup to null, so this branch is also reached by
  // PRs with no checks at all — claiming they pass is simply untrue.
  it("does not claim checks pass when there are no checks", () => {
    const detail = mergeReadiness(
      pr({ mergeStateStatus: "BLOCKED", ciState: null }),
    )?.detail;
    expect(detail).not.toMatch(/checks pass/i);
  });

  it("does say checks pass when they actually did", () => {
    expect(
      mergeReadiness(pr({ mergeStateStatus: "BLOCKED", ciState: "SUCCESS" }))?.detail,
    ).toMatch(/checks pass/i);
  });
});

describe("merge queue", () => {
  const pr = (over: Partial<MyPR> = {}) =>
    ({
      isDraft: false,
      mergeStateStatus: "CLEAN",
      ciState: "SUCCESS",
      mergeQueue: null,
      ...over,
    }) as MyPR;

  it("stops saying ready when the PR is queued", () => {
    // A queued PR reports mergeStateStatus CLEAN, so the row badged
    // green "ready" and sent the reader to a button GitHub had already replaced.
    const badge = mergeReadiness(pr({ mergeQueue: { state: "AWAITING_CHECKS", position: 1 } }));
    expect(badge).toMatchObject({ kind: "yellow", label: "queued" });
    expect(badge?.detail).toMatch(/position 1/);
  });

  it("goes red when the queue rejected it", () => {
    expect(
      mergeReadiness(pr({ mergeQueue: { state: "UNMERGEABLE", position: 1 } })),
    ).toMatchObject({ kind: "red", label: "queue failed" });
  });

  it("outranks the head commit's checks, which the queue has superseded", () => {
    expect(
      mergeReadiness(pr({ ciState: "FAILURE", mergeQueue: { state: "QUEUED", position: 2 } }))
        ?.label,
    ).toBe("queued");
  });

  it("leaves un-queued PRs alone", () => {
    // A repo with no queue reports no entry, which is most PRs and stays the
    // existing behaviour whichever repos have one turned on.
    expect(mergeReadiness(pr())).toMatchObject({ label: "ready" });
    expect(toMergeQueue(false, null)).toBeNull();
    expect(toMergeQueue(undefined, undefined)).toBeNull();
  });

  it("trusts membership when the entry is missing", () => {
    expect(toMergeQueue(true, null)).toEqual({ state: null, position: null });
    expect(mergeReadiness(pr({ mergeQueue: toMergeQueue(true, null) }))?.detail).not.toMatch(
      /position/,
    );
  });
});

describe("copyButtonLabels", () => {
  it("describes the action before copying", () => {
    const l = copyButtonLabels("https://github.com/a/b/pull/1", "a/b#1", false);
    expect(l.aria).toBe("Copy link to a/b#1");
    expect(l.title).toBe("Copy https://github.com/a/b/pull/1");
  });

  it("confirms the result after copying", () => {
    const l = copyButtonLabels("https://github.com/a/b/pull/1", "a/b#1", true);
    expect(l.aria).toBe("Copied a/b#1");
    expect(l.title).toBe("Copied");
  });
});

describe("sortByOldestFirst", () => {
  const at = (createdAt: string, id: number) => ({ createdAt, id });

  it("puts the longest-waiting item first", () => {
    const sorted = sortByOldestFirst([
      at("2026-07-10T00:00:00Z", 1),
      at("2026-07-02T00:00:00Z", 2),
      at("2026-07-06T00:00:00Z", 3),
    ]);
    expect(sorted.map((i) => i.id)).toEqual([2, 3, 1]);
  });

  it("does not mutate its input", () => {
    const input = [at("2026-07-10T00:00:00Z", 1), at("2026-07-02T00:00:00Z", 2)];
    sortByOldestFirst(input);
    expect(input.map((i) => i.id)).toEqual([1, 2]);
  });

  it("handles an empty list", () => {
    expect(sortByOldestFirst([])).toEqual([]);
  });

  it("keeps the incoming order for items opened at the same moment", () => {
    // Two PRs opened in the same second is ordinary — a stack pushed together.
    // Neither is older, so the order must at least be stable rather than random.
    const same = "2026-07-04T09:00:00Z";
    const sorted = sortByOldestFirst([at(same, 1), at(same, 2), at(same, 3)]);
    expect(sorted.map((i) => i.id)).toEqual([1, 2, 3]);
  });
});

describe("openedAge", () => {
  const now = new Date("2026-08-05T12:00:00Z");

  it("reads as a relative age", () => {
    expect(openedAge("2026-08-04T12:00:00Z", now).label).toBe("1d ago");
  });

  it("says opened, not waiting — createdAt is the PR's age", () => {
    // The moment you were *asked* is a separate timeline event GitHub charges
    // for; this must not claim to be it.
    const { detail } = openedAge("2026-08-04T12:00:00Z", now);
    expect(detail).toMatch(/^Opened /);
    expect(detail).not.toMatch(/waiting/i);
  });

  it("admits an unparseable date rather than rendering NaN", () => {
    expect(openedAge("not a date", now)).toEqual({
      label: "—",
      detail: "No open date",
    });
    expect(openedAge("", now).label).toBe("—");
  });
});

describe("repoShortName", () => {
  it("drops the owner", () => {
    expect(repoShortName("Northwind/billing-app")).toBe("billing-app");
  });

  it("returns a bare name unchanged", () => {
    expect(repoShortName("billing-app")).toBe("billing-app");
  });
});

describe("formatDiffSize", () => {
  it("shows additions and deletions", () => {
    expect(formatDiffSize(431, 17)).toBe("+431 −17");
  });

  it("shows zeros rather than blanking a no-op diff", () => {
    expect(formatDiffSize(0, 0)).toBe("+0 −0");
  });

  it("never renders a negative or fractional count", () => {
    expect(formatDiffSize(-5, 2.7)).toBe("+0 −2");
  });

  it("survives a missing count from the API", () => {
    expect(formatDiffSize(NaN, undefined as unknown as number)).toBe("+0 −0");
  });
});

describe("reviewRequestBadge", () => {
  const rr = (over: Partial<ReviewRequestPR> = {}): ReviewRequestPR =>
    ({ isDraft: false, reviewDecision: null, ciState: null, ...over }) as ReviewRequestPR;

  it("says nothing in the ordinary case", () => {
    // Every row here is awaiting your review by definition — a badge saying so
    // would be on every line and inform nothing.
    expect(reviewRequestBadge(rr())).toBeNull();
    expect(reviewRequestBadge(rr({ reviewDecision: "REVIEW_REQUIRED" }))).toBeNull();
  });

  it("flags a draft", () => {
    expect(reviewRequestBadge(rr({ isDraft: true }))?.label).toBe("draft");
  });

  it("flags another reviewer's approval", () => {
    expect(reviewRequestBadge(rr({ reviewDecision: "APPROVED" }))).toMatchObject({
      kind: "green",
      label: "approved",
    });
  });

  it("flags another reviewer's changes request", () => {
    expect(
      reviewRequestBadge(rr({ reviewDecision: "CHANGES_REQUESTED" })),
    ).toMatchObject({ kind: "red", label: "changes" });
  });

  it("reports a failed check ahead of an existing approval", () => {
    expect(
      reviewRequestBadge(rr({ reviewDecision: "APPROVED", ciState: "FAILURE" }))?.label,
    ).toBe("checks failed");
    expect(
      reviewRequestBadge(rr({ reviewDecision: "APPROVED", ciState: "ERROR" }))?.label,
    ).toBe("checks failed");
  });

  it("puts draft ahead of everything, including a failed check", () => {
    expect(
      reviewRequestBadge(rr({ isDraft: true, ciState: "FAILURE" }))?.label,
    ).toBe("draft");
  });

  // A cancelled run is the one thing here that isn't a verdict, so it yields to
  // every verdict — but still beats a blank row, which is what it looked like
  // before while GitHub's own summary line showed red.
  it("mentions a cancelled check only when nothing else is worth saying", () => {
    expect(reviewRequestBadge(rr({ ciState: "CANCELLED" }))).toMatchObject({
      kind: "yellow",
      label: "checks cancelled",
    });
    expect(
      reviewRequestBadge(rr({ reviewDecision: "CHANGES_REQUESTED", ciState: "CANCELLED" }))
        ?.label,
    ).toBe("changes");
    expect(
      reviewRequestBadge(rr({ reviewDecision: "APPROVED", ciState: "CANCELLED" }))?.label,
    ).toBe("approved");
    expect(reviewRequestBadge(rr({ isDraft: true, ciState: "CANCELLED" }))?.label).toBe(
      "draft",
    );
  });

  it("stays quiet while checks are still running", () => {
    expect(reviewRequestBadge(rr({ ciState: "PENDING" }))).toBeNull();
    expect(reviewRequestBadge(rr({ ciState: "EXPECTED" }))).toBeNull();
  });

  it("stays quiet when the checks passed — that is the normal case", () => {
    expect(reviewRequestBadge(rr({ ciState: "SUCCESS" }))).toBeNull();
  });

  it("still reports another reviewer's verdict when checks passed", () => {
    expect(
      reviewRequestBadge(rr({ ciState: "SUCCESS", reviewDecision: "APPROVED" }))?.label,
    ).toBe("approved");
  });
});

describe("summarizeReviewRequests", () => {
  const rr = (over: Partial<ReviewRequestPR> = {}): ReviewRequestPR =>
    ({ isDraft: false, ...over }) as ReviewRequestPR;

  it("says so when nothing is waiting", () => {
    expect(summarizeReviewRequests([], 0)).toBe("nothing waiting on you");
  });

  it("counts what is waiting", () => {
    expect(summarizeReviewRequests([rr(), rr()], 2)).toBe("2 waiting");
  });

  it("names the drafts, which are skippable", () => {
    expect(summarizeReviewRequests([rr(), rr({ isDraft: true })], 2)).toBe(
      "2 waiting · 1 draft",
    );
  });

  it("admits when the queue is longer than the page fetched", () => {
    const prs = Array.from({ length: 50 }, () => rr());
    expect(summarizeReviewRequests(prs, 63)).toBe("50 of 63 waiting");
  });

  it("does not claim a subset when the total matches", () => {
    expect(summarizeReviewRequests([rr()], 1)).toBe("1 waiting");
  });

  it("shows the gap when the rows are missing but the count is not", () => {
    // This was written as "shouldn't happen", and it happens: GitHub's search
    // index disagrees with itself, and the review-requested search was seen
    // live returning issueCount 1 with an empty node list, the same query
    // moments later returning the PR. It also covers a node the token can't
    // resolve, which arrives as null and gets dropped.
    //
    // Both of the simple answers are wrong. "nothing waiting on you" throws
    // away a count GitHub gave us and tells you to relax. "4 waiting" reads as
    // four rows to open above an empty list. The "N of M" form is already how
    // this panel admits to rows it isn't showing.
    expect(summarizeReviewRequests([], 4)).toBe("0 of 4 waiting");
  });

  it("still says nothing is waiting when the count agrees", () => {
    // The zero-of-N form must not swallow the genuinely empty queue.
    expect(summarizeReviewRequests([], 0)).toBe("nothing waiting on you");
  });
});

const session = (
  repoName: string,
  prNumber: number,
  over: Partial<PitwallTerminalSession> = {},
): PitwallTerminalSession => ({
  sessionName: `pitwall_${repoName.replace("/", "-")}_${prNumber}`,
  repo: repoName,
  prNumber,
  createdAt: "2026-08-06T00:00:00.000Z",
  attached: false,
  cwd: null,
  ...over,
});

const worktree = (
  repoName: string,
  prNumber: number,
  over: Partial<PitwallWorktree> = {},
): PitwallWorktree => ({
  repo: repoName,
  prNumber,
  path: `/Users/dev/.pitwall/worktrees/${repoName.replace("/", "-")}/pr-${prNumber}-x`,
  branch: "feature",
  dirty: false,
  ...over,
});

describe("terminalRows", () => {
  it("pairs a session with its open PR", () => {
    const p = pr({ repo: "a/b", number: 1 });
    const rows = terminalRows([session("a/b", 1)], [], [p]);
    expect(rows).toHaveLength(1);
    expect(rows[0].pr).toBe(p);
    expect(rows[0].session?.sessionName).toBe("pitwall_a-b_1");
    expect(rows[0].worktree).toBeNull();
  });

  it("pairs a session with its PR when GitHub and config spell the repo differently", () => {
    // A mismatch here used to read as "pr closed", the hint that deleting is safe.
    const p = pr({ repo: "A/B", number: 1 });
    expect(terminalRows([session("a/b", 1)], [], [p])[0].pr).toBe(p);
  });

  it("leaves pr null when the PR is no longer open", () => {
    expect(terminalRows([session("a/b", 1)], [], [])[0].pr).toBeNull();
  });

  it("joins a session and its worktree into one row", () => {
    const rows = terminalRows([session("a/b", 1)], [worktree("a/b", 1)], []);
    expect(rows).toHaveLength(1);
    expect(rows[0].session).not.toBeNull();
    expect(rows[0].worktree).not.toBeNull();
  });

  it("lists a worktree whose session has already gone", () => {
    // The leftover that has nowhere else to appear: tmux knows nothing about
    // it, so a session-only list would make it unreachable forever.
    const rows = terminalRows([], [worktree("a/b", 7)], []);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ prNumber: 7, session: null });
    expect(rows[0].worktree).not.toBeNull();
  });

  it("does not merge the same PR number across different repos", () => {
    const rows = terminalRows([session("a/b", 1)], [worktree("c/d", 1)], []);
    expect(rows).toHaveLength(2);
  });

  it("sorts by repo then PR so the list doesn't reshuffle between polls", () => {
    const rows = terminalRows(
      [session("b/z", 5), session("a/b", 9), session("a/b", 2)],
      [],
      [],
    );
    expect(rows.map((r) => `${r.repo}#${r.prNumber}`)).toEqual([
      "a/b#2",
      "a/b#9",
      "b/z#5",
    ]);
  });

  it("is empty when there is nothing on either side", () => {
    expect(terminalRows([], [], [pr({ repo: "a/b", number: 1 })])).toEqual([]);
  });
});

describe("worktreeNote", () => {
  const row = (over: Partial<ReturnType<typeof terminalRows>[number]>) => ({
    key: "a/b#1",
    repo: "a/b",
    prNumber: 1,
    session: null,
    worktree: null,
    pr: null,
    prKnown: true,
    ...over,
  });

  it("offers a managed worktree as removable", () => {
    const note = worktreeNote(row({ worktree: worktree("a/b", 1) }));
    expect(note.readOnly).toBe(false);
    expect(note.text).toContain(".pitwall/worktrees");
    expect(note.detail).toMatch(/branch itself is kept/i);
  });

  it("names a reused directory, and marks it read-only", () => {
    // Read-only is the whole point: this is someone's main clone.
    const note = worktreeNote(
      row({ session: session("a/b", 1, { cwd: "/Users/dev/Dev/b" }) }),
    );
    expect(note.readOnly).toBe(true);
    expect(note.text).toBe("reused · /Users/dev/Dev/b");
  });

  it("prefers the managed worktree over the pane's directory", () => {
    // A pane can be cd'd anywhere; if we created a worktree, that is the thing
    // the row is about.
    const note = worktreeNote(
      row({
        worktree: worktree("a/b", 1),
        session: session("a/b", 1, { cwd: "/somewhere/else" }),
      }),
    );
    expect(note.readOnly).toBe(false);
    expect(note.text).not.toContain("/somewhere/else");
  });

  it("says when there is nothing on disk at all", () => {
    const note = worktreeNote(row({ session: session("a/b", 1) }));
    expect(note.text).toBe("no worktree");
    expect(note.readOnly).toBe(true);
  });
});

describe("summarizeTerminalRows", () => {
  const row = (over: Partial<ReturnType<typeof terminalRows>[number]>) => ({
    key: "a/b#1",
    repo: "a/b",
    prNumber: 1,
    session: null,
    worktree: null,
    pr: null,
    prKnown: true,
    ...over,
  });

  it("says none when there is nothing", () => {
    expect(summarizeTerminalRows([])).toBe("none");
  });

  it("counts the two halves separately", () => {
    expect(
      summarizeTerminalRows([
        row({ session: session("a/b", 1), worktree: worktree("a/b", 1) }),
        row({ session: session("a/b", 2) }),
      ]),
    ).toBe("2 tmux sessions · 1 worktree");
  });

  it("doesn't call a worktree-only row a session", () => {
    // The case the count used to get wrong: a session ended, its directory
    // left behind, and the heading still claiming a tmux session existed.
    expect(summarizeTerminalRows([row({ worktree: worktree("a/b", 1) })])).toBe(
      "1 worktree",
    );
  });

  it("singularises a lone session", () => {
    expect(summarizeTerminalRows([row({ session: session("a/b", 1) })])).toBe(
      "1 tmux session",
    );
  });
});

describe("terminalRows — unknown PR list", () => {
  it("marks rows unknown rather than closed when GitHub is unreachable", () => {
    // The bug this guards: a failed fetch used to arrive as an empty PR list,
    // so every live PR's row claimed "pr closed" — which is the row's main hint
    // that deleting its worktree is safe.
    const rows = terminalRows([session("a/b", 1)], [], null);
    expect(rows[0].prKnown).toBe(false);
    expect(rows[0].pr).toBeNull();
  });

  it("marks rows known when the list is genuinely empty", () => {
    const rows = terminalRows([session("a/b", 1)], [], []);
    expect(rows[0].prKnown).toBe(true);
    expect(rows[0].pr).toBeNull();
  });
});

describe("formatFlowCount", () => {
  it("shows an exact count as itself", () => {
    expect(formatFlowCount(32, false)).toBe("32");
    expect(formatFlowCount(0, false)).toBe("0");
  });

  it("marks a count that hit the page cap, because it understates", () => {
    // The whole reason this isn't just the number: a partial count presented as
    // exact is the bug, and "+" is the only honest rendering of "at least".
    expect(formatFlowCount(1500, true)).toBe("1500+");
    expect(formatFlowCount(0, true)).toBe("0+");
  });
});

describe("ticketIndent", () => {
  it("gives a direct child no rule of its own", () => {
    // The family wrapper already draws one; a second at depth 0 would double it.
    expect(ticketIndent(0)).toEqual({ className: "space-y-1.5" });
  });

  it("gives the second rung a rule and no offset", () => {
    expect(ticketIndent(1)).toEqual({
      className: "space-y-1.5 border-l border-line pl-3",
    });
  });

  it("offsets deeper rungs instead of stacking more rules", () => {
    // A border per rung thickets at this width, so past the second it is plain
    // margin — the rule stays single and the depth still reads.
    expect(ticketIndent(2)).toEqual({
      className: "space-y-1.5 border-l border-line pl-3",
      style: { marginLeft: "0.75rem" },
    });
    expect(ticketIndent(3).style).toEqual({ marginLeft: "1.5rem" });
  });
});

describe("countEmphasisClass", () => {
  it("flags a hotspot in red at the threshold and above", () => {
    expect(countEmphasisClass(DEFAULT_HOTSPOT_THRESHOLD)).toBe("text-accent-red");
    expect(countEmphasisClass(DEFAULT_HOTSPOT_THRESHOLD + 50)).toBe("text-accent-red");
  });

  it("dims an empty column so it recedes rather than reads as a number", () => {
    expect(countEmphasisClass(0)).toBe("text-text-dim");
  });

  it("leaves an ordinary count plain", () => {
    expect(countEmphasisClass(1)).toBe("text-text-primary");
    expect(countEmphasisClass(DEFAULT_HOTSPOT_THRESHOLD - 1)).toBe("text-text-primary");
  });

  it("uses a configured threshold instead of the default", () => {
    expect(countEmphasisClass(12, 25)).toBe("text-text-primary");
    expect(countEmphasisClass(25, 25)).toBe("text-accent-red");
    expect(countEmphasisClass(3, 3)).toBe("text-accent-red");
  });

  // The reason it is one function: the PR table and the status cards had the
  // same rule written out separately, which is how a threshold drifts.
  it("uses the same threshold as isHotspot", () => {
    for (const n of [0, 1, 9, 10, 11, 99]) {
      expect(countEmphasisClass(n) === "text-accent-red").toBe(isHotspot(n));
    }
  });
});

describe("viewerIdentities", () => {
  it("names the source each value came from", () => {
    // The whole reason this exists: the name is Linear's and the handle is
    // GitHub's, and one sentence made them look like one identity.
    const [linear, github] = viewerIdentities("Alex Doe", "alexdoe");
    expect(linear).toEqual({ source: "Linear", value: "Alex Doe", href: null });
    expect(github).toEqual({
      source: "GitHub",
      value: "@alexdoe",
      href: "https://github.com/alexdoe",
    });
  });

  it("gives each source its own placeholder, since they load independently", () => {
    // One having answered must not make the other look absent, or present.
    const [linear, github] = viewerIdentities(undefined, "alexdoe");
    expect(linear.value).toBeNull();
    expect(github.value).toBe("@alexdoe");
  });

  it("treats an empty string as absent rather than showing a blank", () => {
    expect(viewerIdentities("", "")[0].value).toBeNull();
    expect(viewerIdentities("", "")[1].value).toBeNull();
  });

  it("has no link for Linear, which has no profile url here", () => {
    expect(viewerIdentities("Alex Doe", "alexdoe")[0].href).toBeNull();
  });

  it("never builds a github url without a login", () => {
    // "https://github.com/undefined" is a real page, which is the trap.
    expect(viewerIdentities("Alex Doe", undefined)[1].href).toBeNull();
  });
});

describe("prListForClipboard", () => {
  const pr = (n: number) => ({ url: `https://github.com/Northwind/billing-app/pull/${n}` });

  it("puts one url per line", () => {
    expect(prListForClipboard([pr(1), pr(2)])).toBe(
      "https://github.com/Northwind/billing-app/pull/1\n" +
        "https://github.com/Northwind/billing-app/pull/2",
    );
  });

  it("leaves no trailing newline", () => {
    // Pasted into a single-line field, a trailing newline either submits the
    // form or leaves a blank row behind.
    expect(prListForClipboard([pr(1)]).endsWith("\n")).toBe(false);
  });

  it("is empty for an empty list", () => {
    expect(prListForClipboard([])).toBe("");
  });
});

describe("copyAllLabels", () => {
  it("says how many links are about to be copied", () => {
    // Four links and forty are very different pastes, so the count is the point.
    expect(copyAllLabels(4, false).label).toBe("Copy 4");
    expect(copyAllLabels(4, false).aria).toBe("Copy all 4 links to the clipboard");
  });

  it("uses the singular for one", () => {
    expect(copyAllLabels(1, false).aria).toBe("Copy all 1 link to the clipboard");
  });

  it("confirms after copying, still saying how many", () => {
    expect(copyAllLabels(4, true)).toEqual({ label: "Copied", aria: "Copied 4 links" });
    expect(copyAllLabels(1, true).aria).toBe("Copied 1 link");
  });
});

describe("linkingContext ticket keys", () => {
  it("collects the configured team and every team the viewer has a ticket in", () => {
    const tickets = [{ teamKey: "SOL" }, { teamKey: "ENG" }, { teamKey: "SOL" }] as LinearTicket[];
    const { ticketKeys } = linkingContext({ myTickets: tickets, orgUrlKey: "o", teamKey: "ENG" });
    expect(ticketKeys.sort()).toEqual(["ENG", "SOL"]);
  });

  it("includes every workspace team, so another team's branch links to its ticket", () => {
    const { ticketKeys } = linkingContext({
      myTickets: [],
      orgUrlKey: "o",
      teamKey: "ENG",
      teamKeys: ["ENG", "OPS"],
    });
    expect(
      ticketIdsFromPR({ title: "Fix login", headRefName: "alex/ops-42-fix-login" }, ticketKeys),
    ).toEqual(["OPS-42"]);
  });

  it("has no keys before Linear has answered", () => {
    expect(linkingContext(undefined).ticketKeys).toEqual([]);
  });
});
