import { afterEach, describe, expect, it, vi } from "vitest";
import {
  countAndSumForFilter,
  fetchLiveCyclePoints,
  fetchStartedStateFlow,
  fetchMyCycleIssues,
  isCurrentCycle,
  parseTicketPR,
  startedStates,
} from "./linear";

describe("isCurrentCycle", () => {
  const cycle = (startsAt: string, endsAt: string) => ({
    number: 1,
    startsAt,
    endsAt,
  });

  it("returns false for a null cycle", () => {
    expect(isCurrentCycle(null)).toBe(false);
  });

  it("returns true when now is between startsAt and endsAt", () => {
    const now = new Date("2026-05-15T12:00:00Z");
    const c = cycle("2026-05-01T00:00:00Z", "2026-05-31T23:59:59Z");
    expect(isCurrentCycle(c, now)).toBe(true);
  });

  it("returns false when now is before the cycle starts", () => {
    const now = new Date("2026-04-15T00:00:00Z");
    const c = cycle("2026-05-01T00:00:00Z", "2026-05-31T23:59:59Z");
    expect(isCurrentCycle(c, now)).toBe(false);
  });

  it("returns false when now is after the cycle ends", () => {
    const now = new Date("2026-06-15T00:00:00Z");
    const c = cycle("2026-05-01T00:00:00Z", "2026-05-31T23:59:59Z");
    expect(isCurrentCycle(c, now)).toBe(false);
  });

  it("includes the start moment as inside the cycle", () => {
    const start = "2026-05-01T00:00:00Z";
    const c = cycle(start, "2026-05-31T23:59:59Z");
    expect(isCurrentCycle(c, new Date(start))).toBe(true);
  });

  it("includes the end moment as inside the cycle", () => {
    const end = "2026-05-31T23:59:59Z";
    const c = cycle("2026-05-01T00:00:00Z", end);
    expect(isCurrentCycle(c, new Date(end))).toBe(true);
  });
});

describe("fetchLiveCyclePoints", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** One GraphQL page of issues. */
  const page = (estimates: Array<number | null>, hasNextPage = false) => ({
    issues: {
      pageInfo: { hasNextPage, endCursor: hasNextPage ? "cursor" : null },
      nodes: estimates.map((estimate) => ({ estimate })),
    },
  });

  /**
   * Stubs fetch, returning queued page payloads in order. Each call's parsed
   * request body is recorded so tests can assert on the filter that was sent.
   */
  function stubPages(pages: unknown[]) {
    const bodies: Array<{ variables: { filter: unknown; after: string | null } }> = [];
    let i = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body: string }) => {
        bodies.push(JSON.parse(init.body));
        const data = pages[Math.min(i++, pages.length - 1)];
        return { ok: true, json: async () => ({ data }) };
      }),
    );
    return bodies;
  }

  it("sums estimates for both the total and completed connections", async () => {
    // fetchLiveCyclePoints issues the two connections concurrently, so queue a
    // single shared payload rather than relying on call ordering.
    stubPages([page([5, 3, 2])]);
    await expect(fetchLiveCyclePoints("key", "ENG", 56)).resolves.toEqual({
      total: 10,
      completed: 10,
    });
  });

  it("keeps total and completed apart when they differ", async () => {
    // Answering both requests with one payload can't tell the two sums apart,
    // so swapping them in the return would pass. Route by the filter instead.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body: string }) => {
        const { variables } = JSON.parse(init.body) as { variables: { filter: { state?: unknown } } };
        const data = variables.filter.state ? page([3]) : page([5, 3, 2]);
        return { ok: true, json: async () => ({ data }) };
      }),
    );
    await expect(fetchLiveCyclePoints("key", "ENG", 56)).resolves.toEqual({
      total: 10,
      completed: 3,
    });
  });

  it("treats a null or absent estimate as zero rather than NaN", async () => {
    // A node with no `estimate` key at all is what makes the `?? 0` guard
    // load-bearing: `x + null` coerces to x, but `x + undefined` is NaN. Without
    // the absent-key case this test passes even if the guard is deleted.
    stubPages([
      {
        issues: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [{ estimate: 5 }, { estimate: null }, {}],
        },
      },
    ]);
    const result = await fetchLiveCyclePoints("key", "ENG", 56);
    expect(result).toEqual({ total: 5, completed: 5 });
    expect(Number.isNaN(result!.total)).toBe(false);
  });

  it("scopes the query to the requested team and cycle", async () => {
    const bodies = stubPages([page([1])]);
    await fetchLiveCyclePoints("key", "ENG", 56);
    for (const b of bodies) {
      expect(b.variables.filter).toMatchObject({
        team: { key: { eq: "ENG" } },
        cycle: { number: { eq: 56 } },
      });
    }
  });

  it("filters one connection to completed states only", async () => {
    const bodies = stubPages([page([1])]);
    await fetchLiveCyclePoints("key", "ENG", 56);
    const completedFilters = bodies.filter(
      (b) => (b.variables.filter as { state?: unknown }).state !== undefined,
    );
    expect(completedFilters).toHaveLength(1);
    expect(completedFilters[0].variables.filter).toMatchObject({
      state: { type: { eq: "completed" } },
    });
  });

  it("follows pagination and sums across pages", async () => {
    // Two pages then a final one; both connections walk the same queue.
    stubPages([page([10], true), page([5], true), page([1])]);
    const result = await fetchLiveCyclePoints("key", "ENG", 56);
    expect(result).not.toBeNull();
    expect(result!.total).toBeGreaterThan(10); // more than the first page alone
  });

  it("passes the cursor back on the follow-up request", async () => {
    const bodies = stubPages([page([1], true), page([1])]);
    await fetchLiveCyclePoints("key", "ENG", 56);
    expect(bodies[0].variables.after).toBeNull();
    expect(bodies.some((b) => b.variables.after === "cursor")).toBe(true);
  });

  it("returns null rather than a truncated total when the page cap is hit", async () => {
    // Always hasNextPage → never terminates on its own, so the 6-page cap must.
    stubPages([page([100], true)]);
    await expect(fetchLiveCyclePoints("key", "ENG", 56)).resolves.toBeNull();
  });

  it("stops requesting once the cap is reached", async () => {
    const bodies = stubPages([page([1], true)]);
    await fetchLiveCyclePoints("key", "ENG", 56);
    expect(bodies.length).toBe(12); // 6-page cap x 2 connections
  });

  it("returns null when the API errors, so the caller keeps its snapshot", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 429, text: async () => "rate limited" })),
    );
    await expect(fetchLiveCyclePoints("key", "ENG", 56)).resolves.toBeNull();
  });

  it("returns null when GraphQL reports errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ errors: [{ message: "Query too complex" }] }),
      })),
    );
    await expect(fetchLiveCyclePoints("key", "ENG", 56)).resolves.toBeNull();
  });

  it("returns null when fetch itself rejects", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    await expect(fetchLiveCyclePoints("key", "ENG", 56)).resolves.toBeNull();
  });

  it("reports zero for an empty cycle instead of null", async () => {
    stubPages([page([])]);
    await expect(fetchLiveCyclePoints("key", "ENG", 56)).resolves.toEqual({
      total: 0,
      completed: 0,
    });
  });
});

describe("fetchMyCycleIssues", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** One page of the viewer's assigned issues. */
  const page = (count: number, hasNextPage = false) => ({
    viewer: {
      assignedIssues: {
        pageInfo: { hasNextPage, endCursor: hasNextPage ? "cursor" : null },
        nodes: Array.from({ length: count }, () => ({
          estimate: 1,
          cycle: { number: 56 },
          state: { type: "completed" },
        })),
      },
    },
  });

  function stubPages(pages: unknown[]) {
    const bodies: Array<{ variables: { after: string | null; cycleNumbers: number[] } }> = [];
    let i = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body: string }) => {
        bodies.push(JSON.parse(init.body));
        const data = pages[Math.min(i++, pages.length - 1)];
        return { ok: true, json: async () => ({ data }) };
      }),
    );
    return bodies;
  }

  it("returns a single page when there is nothing more", async () => {
    stubPages([page(3)]);
    await expect(fetchMyCycleIssues("k", "ENG", [56])).resolves.toHaveLength(3);
  });

  it("follows pagination and accumulates every page", async () => {
    // This is the regression: the old code took page one and dropped the rest.
    stubPages([page(250, true), page(250, true), page(7)]);
    const nodes = await fetchMyCycleIssues("k", "ENG", [56, 55, 54]);
    expect(nodes).toHaveLength(507);
  });

  it("passes the cursor back on follow-up requests", async () => {
    const bodies = stubPages([page(250, true), page(1)]);
    await fetchMyCycleIssues("k", "ENG", [56]);
    expect(bodies[0].variables.after).toBeNull();
    expect(bodies[1].variables.after).toBe("cursor");
  });

  it("forwards the requested cycle numbers", async () => {
    const bodies = stubPages([page(1)]);
    await fetchMyCycleIssues("k", "ENG", [56, 55, 54]);
    expect(bodies[0].variables.cycleNumbers).toEqual([56, 55, 54]);
  });

  it("stops at the page cap rather than looping forever", async () => {
    const bodies = stubPages([page(250, true)]);
    const nodes = await fetchMyCycleIssues("k", "ENG", [56]);
    expect(bodies).toHaveLength(6); // MAX_CYCLE_PAGES
    expect(nodes).toHaveLength(1500);
  });

  it("tolerates a response with no pageInfo", async () => {
    stubPages([{ viewer: { assignedIssues: { nodes: [] } } }]);
    await expect(fetchMyCycleIssues("k", "ENG", [56])).resolves.toEqual([]);
  });
});

describe("parseTicketPR", () => {
  const attachment = (over = {}) => ({
    url: "https://github.com/Northwind/billing-app/pull/3647",
    sourceType: "github",
    metadata: { status: "open", draft: false },
    ...over,
  });

  it("reads the state Linear already tracks, so GitHub needn't be asked", () => {
    expect(parseTicketPR(attachment())).toEqual({
      url: "https://github.com/Northwind/billing-app/pull/3647",
      repo: "Northwind/billing-app",
      number: 3647,
      status: "open",
      isDraft: false,
    });
  });

  it("recognises a merged PR", () => {
    expect(parseTicketPR(attachment({ metadata: { status: "merged" } }))?.status).toBe(
      "merged",
    );
  });

  it("distinguishes closed-unmerged from merged", () => {
    expect(parseTicketPR(attachment({ metadata: { status: "closed" } }))?.status).toBe(
      "closed",
    );
  });

  it("carries the draft flag", () => {
    expect(
      parseTicketPR(attachment({ metadata: { status: "open", draft: true } }))?.isDraft,
    ).toBe(true);
  });

  it("rejects non-GitHub attachments", () => {
    // Linear also attaches Slack threads and Claude artifacts to issues.
    expect(
      parseTicketPR({
        url: "https://northwind.slack.com/archives/C1",
        sourceType: "slack",
      }),
    ).toBeNull();
    expect(
      parseTicketPR(attachment({ url: "https://github.com/a/b/issues/1" })),
    ).toBeNull();
  });

  it("assumes open when Linear reports no status, rather than hiding the PR", () => {
    // A wrongly shown PR is recoverable; a hidden live one is not.
    expect(parseTicketPR(attachment({ metadata: {} }))?.status).toBe("open");
    expect(parseTicketPR(attachment({ metadata: null }))?.status).toBe("open");
  });
});

describe("startedStates", () => {
  const state = (name: string, type: string, position: number) => ({
    id: name.toLowerCase().replace(/\s+/g, "-"),
    name,
    type,
    color: "#abc",
    position,
  });

  // The point of the whole change: which statuses are "in flight" is Linear's
  // answer, not a list written down here, so renaming one or adding one needs
  // no code change.
  it("keeps only what Linear categorises as started", () => {
    expect(
      startedStates([
        state("Backlog", "backlog", 0),
        state("Ready for Development", "unstarted", 1),
        state("In Progress", "started", 2),
        state("Done", "completed", 9),
        state("Canceled", "canceled", 10),
      ]).map((s) => s.name),
    ).toEqual(["In Progress"]);
  });

  it("orders them the way Linear's own settings screen does", () => {
    expect(
      startedStates([
        state("In Acceptance", "started", 30),
        state("In Progress", "started", 10),
        state("In Review", "started", 20),
      ]).map((s) => s.name),
    ).toEqual(["In Progress", "In Review", "In Acceptance"]);
  });

  it("admits a status nobody wrote down, which is the point", () => {
    // "Prod Loom" and "Claude PR" exist on the real team and were invisible
    // while the panel read two hardcoded names.
    expect(
      startedStates([
        state("Claude PR", "started", 5),
        state("Prod Loom", "started", 6),
      ]).map((s) => s.name),
    ).toEqual(["Claude PR", "Prod Loom"]);
  });

  it("does not mutate the array it was given", () => {
    // It sorts, and the caller's array is the raw API response.
    const input = [state("B", "started", 2), state("A", "started", 1)];
    startedStates(input);
    expect(input.map((s) => s.name)).toEqual(["B", "A"]);
  });

  it("is empty when the team has no in-flight states at all", () => {
    expect(startedStates([state("Done", "completed", 1)])).toEqual([]);
    expect(startedStates([])).toEqual([]);
  });
});

describe("fetchStartedStateFlow", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("counts each started state, in Linear's order, filtered to the team and that state", async () => {
    const filters: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body: string }) => {
        const { variables } = JSON.parse(init.body) as {
          variables: { filter: { state: { id: { eq: string } } } };
        };
        filters.push(variables.filter);
        const n = variables.filter.state.id.eq === "review" ? 2 : 1;
        return {
          ok: true,
          json: async () => ({
            data: {
              issues: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: Array.from({ length: n }, () => ({ estimate: 3 })),
              },
            },
          }),
        };
      }),
    );
    const flow = await fetchStartedStateFlow("key", "ENG", [
      { id: "review", name: "In Review", type: "started", color: "#a", position: 3 },
      { id: "done", name: "Done", type: "completed", color: "#b", position: 9 },
      { id: "doing", name: "Doing", type: "started", color: "#c", position: 2 },
    ]);
    expect(flow.map((f) => [f.name, f.count, f.points])).toEqual([
      ["Doing", 1, 3],
      ["In Review", 2, 6],
    ]);
    expect(filters).toContainEqual({ team: { key: { eq: "ENG" } }, state: { id: { eq: "review" } } });
  });
});

describe("countAndSumForFilter", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const page = (estimates: Array<number | null>, hasNextPage = false) => ({
    issues: {
      pageInfo: { hasNextPage, endCursor: hasNextPage ? "cursor" : null },
      nodes: estimates.map((estimate) => ({ estimate })),
    },
  });

  function stubPages(pages: unknown[]) {
    const bodies: unknown[] = [];
    let i = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body: string }) => {
        bodies.push(JSON.parse(init.body));
        const data = pages[Math.min(i++, pages.length - 1)];
        return { ok: true, json: async () => ({ data }) };
      }),
    );
    return bodies;
  }

  it("counts every issue and sums their estimates", async () => {
    stubPages([page([3, 5, null])]);
    await expect(countAndSumForFilter("key", {})).resolves.toEqual({
      count: 3,
      points: 8,
      truncated: false,
    });
  });

  it("follows pagination rather than reading one page", async () => {
    // The silent-undercount bug this codebase has hit twice came from ignoring
    // hasNextPage, and a per-status count is exactly where it would recur.
    const bodies = stubPages([page([1, 2], true), page([4])]) as Array<{
      variables: { after: string | null };
    }>;
    await expect(countAndSumForFilter("key", {})).resolves.toEqual({
      count: 3,
      points: 7,
      truncated: false,
    });
    expect(bodies).toHaveLength(2);
    // Counting the requests isn't enough: a second call that forgot to send the
    // cursor would re-read page one and double the first page's rows while
    // still looking like correct pagination.
    expect(bodies[0].variables.after).toBeNull();
    expect(bodies[1].variables.after).toBe("cursor");
  });

  it("reports truncation instead of a partial total, and stops at the page cap", async () => {
    // Every page claims another follows, so this only ends at MAX_CYCLE_PAGES.
    const bodies = stubPages([page([1], true)]);
    const result = await countAndSumForFilter("key", {});
    expect(result.truncated).toBe(true);
    expect(result.count).toBe(bodies.length);
    // Pinned so a raised cap is a deliberate change, not an accident.
    expect(bodies).toHaveLength(6);
  });

  it("counts an issue with no estimate, since it is still a ticket", async () => {
    stubPages([page([null, null])]);
    await expect(countAndSumForFilter("key", {})).resolves.toEqual({
      count: 2,
      points: 0,
      truncated: false,
    });
  });
});
