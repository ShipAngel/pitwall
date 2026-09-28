import { afterEach, describe, expect, it, vi } from "vitest";
import { serverWorstCaseFitsClient } from "./timeouts";
import {
  APPROVED_SEARCHES_PER_QUERY,
  buildGitHubQueries,
  configuredRepoFilter,
  fetchGitHubData,
  fetchGitHubGraphQL,
  unavailableRepos,
  WORST_CASE_REQUEST_MS,
  getRepoOpenCount,
  approvedAlias,
  getRepoApprovedCount,
  getRepoWipCount,
  repoAlias,
  repoScopeQualifiers,
  type RawGitHubResponse,
} from "./github";

describe("repoAlias", () => {
  it("produces a valid GraphQL alias for typical names", () => {
    const alias = repoAlias("Acme", "forms-app");
    expect(alias).toMatch(/^[a-zA-Z_][a-zA-Z0-9_]*$/);
  });

  it("replaces dashes and dots with underscores", () => {
    const alias = repoAlias("my-org", "weird.repo-name");
    expect(alias).toBe("repo_my_org_weird_repo_name");
  });

  it("is deterministic", () => {
    expect(repoAlias("a", "b")).toBe(repoAlias("a", "b"));
  });

  it("differs across distinct repos", () => {
    expect(repoAlias("a", "b")).not.toBe(repoAlias("a", "c"));
  });
});

describe("repoScopeQualifiers", () => {
  it("emits one repo: qualifier per configured repo", () => {
    expect(
      repoScopeQualifiers([
        { owner: "Acme", name: "alpha" },
        { owner: "Acme", name: "beta" },
      ]),
    ).toBe("repo:Acme/alpha repo:Acme/beta");
  });

  it("is empty for an empty repo list", () => {
    expect(repoScopeQualifiers([])).toBe("");
  });
});

describe("configuredRepoFilter", () => {
  const repos = [
    { owner: "Acme", name: "billing-app" },
    { owner: "Acme", name: "forms-app" },
  ];

  it("accepts a configured repo", () => {
    expect(configuredRepoFilter(repos)("Acme/billing-app")).toBe(true);
  });

  it("rejects a repo outside the configured list", () => {
    expect(configuredRepoFilter(repos)("sam/side-project")).toBe(false);
  });

  it("rejects a same-named repo under a different owner", () => {
    expect(configuredRepoFilter(repos)("OtherOrg/billing-app")).toBe(false);
  });

  it("matches case-insensitively, as GitHub does", () => {
    expect(configuredRepoFilter(repos)("acme/Billing-App")).toBe(true);
  });

  it("rejects everything when no repos are configured", () => {
    expect(configuredRepoFilter([])("Acme/billing-app")).toBe(false);
  });
});

describe("buildGitHubQueries", () => {
  const repos = [
    { owner: "Acme", name: "alpha" },
    { owner: "Acme", name: "beta" },
  ];

  /** Every query actually sent, in one list, for set-wide assertions. */
  const allQueries = (repoList = repos, wipLabel?: string) => {
    const q = buildGitHubQueries(repoList, wipLabel);
    return [q.counts, q.myPRs, q.reviewRequests, ...q.approved];
  };

  // The whole point of the split: GitHub kills a query still running at ~10s and
  // answers with nginx's 502 rather than a GraphQL error, and everything here in
  // one query measured 12.6s - it failed on every refresh. Merging any two of
  // these back together goes straight back to that.
  it("keeps the counts, both searches and the approved chunks separate", () => {
    const q = buildGitHubQueries(repos);
    expect(q.counts).toContain("viewer { login }");
    expect(q.counts).not.toContain("search");
    expect(q.myPRs).toContain("myOpenPRs: search");
    expect(q.myPRs).not.toContain("reviewRequests");
    expect(q.reviewRequests).toContain("reviewRequests: search");
    expect(q.reviewRequests).not.toContain("myOpenPRs");
    expect(q.approved.every((a) => !a.includes("myOpenPRs"))).toBe(true);
  });

  it("never emits a query with an empty selection set", () => {
    // `query { }` is a syntax error, so the no-repos case can't just drop the
    // repo blocks and send the wrapper. viewer is what keeps `counts` valid.
    for (const query of [...allQueries(), ...allQueries([])]) {
      expect(query).not.toMatch(/query\s*\{\s*\}/);
    }
  });

  it("includes viewer and both searches even with no repos", () => {
    const q = buildGitHubQueries([]);
    expect(q.counts).toContain("viewer { login }");
    expect(q.myPRs).toContain("is:pr is:open author:@me");
    expect(q.reviewRequests).toContain(
      "is:pr is:open review-requested:@me archived:false",
    );
  });

  it("uses the broad review-requested filter, not the direct-only one", () => {
    // user-review-requested:@me excludes requests that arrive via a team, which
    // is how most of them land. Guards against a "tightening" of this filter —
    // matched inside the search argument, so the explanatory comment beside it
    // (which names the rejected form) doesn't trip the assertion.
    expect(buildGitHubQueries([]).reviewRequests).not.toMatch(
      /query: "[^"]*user-review-requested/,
    );
  });

  it("counts review requests with issueCount, the field search actually has", () => {
    // totalCount doesn't exist on SearchResultItemConnection. Asking for it is a
    // hard GraphQL error that fails the whole query, so it took the entire GitHub
    // panel down — mocked fetches happily returned it, only the live API refused.
    const query = buildGitHubQueries([]).reviewRequests;
    // Line-anchored so it matches a selected field, not the "#" comment beside it
    // that explains the trap. The query's other legitimate use of totalCount is
    // `checkSuites`, in the PR fragment and so always present; it is written
    // inline with its opening brace to stay off this line-anchored match, and
    // github.ts says so where it could be reformatted.
    expect(query).toMatch(/^\s*issueCount\s*$/m);
    expect(query).not.toMatch(/^\s*totalCount\s*$/m);
  });

  it("asks the approved searches for issueCount too", () => {
    const q = buildGitHubQueries(repos);
    expect(q.approved.join("\n")).toContain("issueCount");
    expect(q.approved.join("\n")).not.toMatch(/^\s*totalCount\s*$/m);
  });

  it("requests the author and diff size for review requests only", () => {
    const q = buildGitHubQueries([]);
    expect(q.reviewRequests).toContain("author { login }");
    expect(q.reviewRequests).toContain("additions");
    expect(q.reviewRequests).toContain("deletions");
    expect(q.myPRs).not.toContain("author { login }");
  });

  it("sends the shared field fragment with each PR query", () => {
    // Separate requests, so "shared" now means defined in one place in the
    // source and sent twice - a query referencing a fragment it doesn't carry
    // is a hard error.
    const q = buildGitHubQueries([]);
    for (const query of [q.myPRs, q.reviewRequests]) {
      expect(query).toContain("fragment prCore on PullRequest");
      expect(query.match(/\.\.\.prCore/g)).toHaveLength(1);
    }
  });

  // The rollup state alone can't tell a cancelled run from a failed one, and
  // both PR lists badge on that distinction — so the counts belong in prCore,
  // where each search picks them up once.
  it("asks the check rollup for its per-state counts, on both searches", () => {
    const q = buildGitHubQueries([]);
    for (const query of [q.myPRs, q.reviewRequests]) {
      expect(query).toContain("checkRunCountsByState { state count }");
      expect(query).toContain("statusContextCountsByState { state count }");
      expect(query.match(/checkRunCountsByState/g)).toHaveLength(1);
      expect(query.indexOf("checkRunCountsByState")).toBeGreaterThan(
        query.indexOf("fragment prCore"),
      );
    }
  });

  it("asks for mergeStateStatus on the viewer's own PRs only", () => {
    // Kept scoped because My PRs is the only panel that renders a merge
    // verdict, so nothing else has a use for the field.
    //
    // It is not a permission question: mergeStateStatus resolves at
    // viewerPermission READ (checked against facebook/react). Containment is
    // why the assertion stays. A field-level denial anywhere fails the whole route,
    // because fetchGitHubData uses Promise.all, so splitting the panel into
    // separate queries does not isolate one query's failure from the others.
    const q = buildGitHubQueries([]);
    expect(q.myPRs.match(/mergeStateStatus/g)).toHaveLength(1);
    expect(q.reviewRequests).not.toContain("mergeStateStatus");
    expect(q.counts).not.toContain("mergeStateStatus");
  });

  it("asks for the merge queue on the viewer's own PRs only", () => {
    // Not for the same reason as the field above: these two resolve fine
    // without push access (verified live against facebook/react with
    // viewerPermission READ). They are scoped to your own PRs because that is
    // the only place the answer is used — mergeReadiness is the my-PRs badge,
    // and the review queue has no merge verdict to correct. Asked for on every
    // configured repo, not a chosen one: a repo with no queue just answers no.
    // Matched as field syntax, not as substrings: the comment above these two
    // fields names them both in prose, so `toContain` passed with the actual
    // field lines deleted — and the whole feature dies silently that way, with
    // GitHub omitting the fields and the misleading green badge coming back.
    const q = buildGitHubQueries([]);
    expect(q.myPRs).toMatch(/^\s*isInMergeQueue$/m);
    expect(q.myPRs).toMatch(/^\s*mergeQueueEntry \{$/m);
    expect(q.reviewRequests).not.toContain("isInMergeQueue");
    expect(q.reviewRequests).not.toContain("mergeQueueEntry");
    expect(q.counts).not.toContain("isInMergeQueue");
    expect(q.counts).not.toContain("mergeQueueEntry");
  });

  it("scopes both PR searches to the configured repos", () => {
    const q = buildGitHubQueries(repos);
    expect(q.myPRs).toContain(
      'query: "is:pr is:open author:@me archived:false repo:Acme/alpha repo:Acme/beta"',
    );
    expect(q.reviewRequests).toContain(
      'query: "is:pr is:open review-requested:@me archived:false repo:Acme/alpha repo:Acme/beta"',
    );
  });

  it("leaves the searches unscoped when no repos are configured", () => {
    // There is no qualifier meaning "nothing", so an empty config produces an
    // unrestricted search — configuredRepoFilter is what keeps that safe, and
    // this pins the contract the route depends on.
    const q = buildGitHubQueries([]);
    expect(q.myPRs).toContain('query: "is:pr is:open author:@me archived:false"');
    expect(allQueries([]).join("\n")).not.toContain("repo:");
  });

  it("escapes a repo name that would break out of the search literal", () => {
    expect(
      buildGitHubQueries([{ owner: 'we"ird', name: "alpha" }]).myPRs,
    ).toContain('repo:we\\"ird/alpha');
  });

  it("aliases each configured repo in the counts query", () => {
    const q = buildGitHubQueries(repos);
    expect(q.counts).toContain('repository(owner: "Acme", name: "alpha")');
    expect(q.counts).toContain('repository(owner: "Acme", name: "beta")');
    expect(q.counts).toContain(repoAlias("Acme", "alpha") + ":");
    expect(q.counts).toContain(repoAlias("Acme", "beta") + ":");
  });

  it("requests open pull request totalCount", () => {
    const q = buildGitHubQueries([{ owner: "x", name: "y" }]);
    expect(q.counts).toContain("pullRequests(states: OPEN, first: 1)");
    expect(q.counts).toContain("totalCount");
  });

  it("requests a WIP-labelled count using the default label", () => {
    expect(buildGitHubQueries([{ owner: "x", name: "y" }]).counts).toContain(
      'wip: pullRequests(states: OPEN, labels: ["wip"]',
    );
  });

  it("uses a custom WIP label when provided", () => {
    const q = buildGitHubQueries([{ owner: "x", name: "y" }], "in-progress");
    expect(q.counts).toContain('labels: ["in-progress"]');
    expect(q.counts).not.toContain('labels: ["wip"]');
  });

  it("escapes a WIP label containing quotes", () => {
    expect(
      buildGitHubQueries([{ owner: "x", name: "y" }], 'we"ird').counts,
    ).toContain('labels: ["we\\"ird"]');
  });

  it("chunks the approved searches and asks for every repo exactly once", () => {
    // The 18 of these were 6.3s of the 10s ceiling on their own, at ~350ms each,
    // because GitHub resolves top-level aliases serially. Chunking is what makes
    // them concurrent; losing or duplicating a repo here would silently report
    // its approved count as zero.
    const many = Array.from({ length: 15 }, (_, i) => ({
      owner: "Acme",
      name: `r${i}`,
    }));
    const q = buildGitHubQueries(many);
    expect(q.approved).toHaveLength(
      Math.ceil(many.length / APPROVED_SEARCHES_PER_QUERY),
    );
    // Not derived from the constant, unlike the line above: that assertion
    // moves with whatever the constant says and so can't notice chunking being
    // switched off. 15 repos must land in more than one query.
    expect(q.approved.length).toBeGreaterThan(1);
    const joined = q.approved.join("\n");
    for (const r of many) {
      expect(joined.match(new RegExp(approvedAlias(r.owner, r.name) + ":", "g")))
        .toHaveLength(1);
    }
    for (const query of q.approved) {
      const searches = query.match(/search\(/g) ?? [];
      expect(searches.length).toBeGreaterThan(0);
      expect(searches.length).toBeLessThanOrEqual(APPROVED_SEARCHES_PER_QUERY);
    }
  });

  it("keeps each approved query small enough to clear GitHub's 10s ceiling", () => {
    // ~350ms per search, measured, resolved serially. A cap this side of 8 keeps
    // a chunk near 2s; raise it far and these rejoin the single 12.6s query that
    // 502'd on every refresh. Pinned as a literal because every other assertion
    // about chunking is computed from this constant and moves with it.
    expect(APPROVED_SEARCHES_PER_QUERY).toBeGreaterThan(0);
    expect(APPROVED_SEARCHES_PER_QUERY).toBeLessThanOrEqual(8);
  });

  it("emits no approved queries when no repos are configured", () => {
    expect(buildGitHubQueries([]).approved).toEqual([]);
  });

  it("omits archived:false from the approved searches", () => {
    // Naming one repo makes the qualifier a no-op or a silent zero, and the
    // silent zero would drop a configured-but-archived repo's approved count to
    // nothing while openCount, which has no such filter, kept its PRs.
    expect(buildGitHubQueries(repos).approved.join("\n")).not.toContain(
      "archived:false",
    );
  });
});

describe("unavailableRepos", () => {
  it("names configured repos GitHub answered null for, and only those", () => {
    const data = {
      viewer: { login: "me" },
      repo_acme_alpha: { pullRequests: { totalCount: 0 } },
      repo_acme_gone: null,
    } as unknown as RawGitHubResponse;
    expect(
      unavailableRepos(data, [
        { owner: "acme", name: "alpha" },
        { owner: "acme", name: "gone" },
      ]),
    ).toEqual(["acme/gone"]);
  });
});

describe("fetchGitHubGraphQL", () => {
  const okResponse = (data: unknown) =>
    new Response(JSON.stringify({ data }), { status: 200 });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the data on the first success", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => okResponse({ viewer: "me" }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchGitHubGraphQL("tok", "query {}")).resolves.toEqual({
      viewer: "me",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([503, 504])("retries once on a fast %i too", async (status) => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("unavailable", { status }))
      .mockResolvedValueOnce(okResponse({ viewer: "me" }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchGitHubGraphQL("tok", "query {}")).resolves.toEqual({ viewer: "me" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws on a reply with no data and no errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: null }), { status: 200 })));
    await expect(fetchGitHubGraphQL("tok", "query {}")).rejects.toThrow("empty response");
  });

  it("returns the rest of the data when the only errors are repos it couldn't find", async () => {
    // The live shape for a misspelled or inaccessible repo: its block is null,
    // with a NOT_FOUND error beside the data.
    const body = {
      data: { viewer: { login: "me" }, repo_acme_gone: null },
      errors: [{ type: "NOT_FOUND", path: ["repo_acme_gone"], message: "Could not resolve" }],
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));
    await expect(fetchGitHubGraphQL("tok", "query {}")).resolves.toEqual(body.data);
  });

  it("still throws when any error is something other than NOT_FOUND", async () => {
    const body = {
      data: { viewer: { login: "me" } },
      errors: [{ type: "NOT_FOUND" }, { message: "Field 'totalCount' doesn't exist" }],
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));
    await expect(fetchGitHubGraphQL("tok", "query {}")).rejects.toThrow("GitHub GraphQL errors");
  });

  it("still throws on NOT_FOUND when there is no data at all", async () => {
    const body = { data: null, errors: [{ type: "NOT_FOUND" }] };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));
    await expect(fetchGitHubGraphQL("tok", "query {}")).rejects.toThrow("GitHub GraphQL errors");
  });

  it("retries once on a 502 and succeeds", async () => {
    // A GitHub query killed for running too long comes back as nginx's 502 with
    // an HTML body, which is also what its genuinely transient 502s look like.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("<html>502</html>", { status: 502 }))
      .mockResolvedValueOnce(okResponse({ viewer: "me" }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchGitHubGraphQL("tok", "query {}")).resolves.toEqual({
      viewer: "me",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives up after the retry and reports the status", async () => {
    // A fresh Response per call: a body can only be read once, and both
    // attempts read it.
    const fetchMock = vi
      .fn()
      .mockImplementation(async () => new Response("<html>502</html>", { status: 502 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchGitHubGraphQL("tok", "query {}")).rejects.toThrow(
      /GitHub API 502/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries a connection failure, not just an HTTP status", async () => {
    // A dead keep-alive socket or DNS not yet back after a resume from sleep
    // rejects the fetch rather than answering, and that used to escape the
    // retry loop and 500 the whole panel for a full refresh interval. It got
    // likelier with the split: six concurrent requests a refresh, not one.
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockImplementationOnce(
        async () =>
          new Response(JSON.stringify({ data: { viewer: "me" } }), {
            status: 200,
          }),
      );
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchGitHubGraphQL("tok", "query {}")).resolves.toEqual({
      viewer: "me",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reports a connection failure that keeps failing", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(async () => {
        throw new TypeError("fetch failed");
      });
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchGitHubGraphQL("tok", "query {}")).rejects.toThrow(
      /fetch failed/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry our own request timeout", async () => {
    // It can only fire after REQUEST_TIMEOUT_MS, which is past
    // RETRY_ONLY_UNDER_MS, so the slow-failure guard refuses it with no special
    // case. Retrying would double the wait before the panel says anything.
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn().mockImplementation(async () => {
        vi.advanceTimersByTime(15_000);
        throw new Error("The operation was aborted due to timeout");
      });
      vi.stubGlobal("fetch", fetchMock);
      await expect(fetchGitHubGraphQL("tok", "query {}")).rejects.toThrow(
        /aborted due to timeout/,
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry a 502 that took the ~10s ceiling to arrive", async () => {
    // That 502 is GitHub killing the query for being too heavy, and it will be
    // just as heavy half a second later - the retry can only double how long
    // the panel takes to admit it is broken. Fake timers so the elapsed time is
    // asserted rather than waited for.
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn().mockImplementation(async () => {
        vi.advanceTimersByTime(10_500);
        return new Response("<html>502</html>", { status: 502 });
      });
      vi.stubGlobal("fetch", fetchMock);
      await expect(fetchGitHubGraphQL("tok", "query {}")).rejects.toThrow(
        /GitHub API 502/,
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry a 401", async () => {
    // A bad token won't come good half a second later, and a retry would double
    // the delay before the panel says what is actually wrong.
    const fetchMock = vi
      .fn()
      .mockImplementation(async () => new Response("Bad credentials", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchGitHubGraphQL("tok", "query {}")).rejects.toThrow(
      /GitHub API 401/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry a GraphQL-level error", async () => {
    const fetchMock = vi.fn().mockImplementation(
      async () =>
        new Response(JSON.stringify({ errors: [{ message: "nope" }] }), {
          status: 200,
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchGitHubGraphQL("tok", "query {}")).rejects.toThrow(
      /GitHub GraphQL errors/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("WORST_CASE_REQUEST_MS", () => {
  it("fits inside the browser's own abort", () => {
    // The two budgets used to sit in separate files with only a comment
    // between them, and the gap closed to 1.5s unnoticed. This is the check
    // that stops it: the retry sequence has to finish with room for config
    // reading, reshaping, serialisation and Next's overhead, or the panel
    // shows a bare TimeoutError instead of the GitHub error worth reading.
    expect(serverWorstCaseFitsClient(WORST_CASE_REQUEST_MS)).toBe(true);
  });
});

describe("fetchGitHubData", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const queries = {
    counts: "counts",
    myPRs: "myPRs",
    reviewRequests: "reviewRequests",
    approved: ["approved0", "approved1"],
  };

  it("merges every query's top-level fields into one response", async () => {
    const byQuery: Record<string, unknown> = {
      counts: { viewer: { login: "me" }, repo_a_b: { pullRequests: { totalCount: 3 } } },
      myPRs: { myOpenPRs: { nodes: [] } },
      reviewRequests: { reviewRequests: { issueCount: 2, nodes: [] } },
      approved0: { approved_repo_a_b: { issueCount: 1 } },
      approved1: { approved_repo_c_d: { issueCount: 4 } },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body: string }) => {
        const { query } = JSON.parse(init.body) as { query: string };
        return new Response(JSON.stringify({ data: byQuery[query] }), {
          status: 200,
        });
      }),
    );
    const data = await fetchGitHubData("tok", queries);
    expect(data.viewer.login).toBe("me");
    expect(getRepoOpenCount(data, "a", "b")).toBe(3);
    expect(getRepoApprovedCount(data, "a", "b")).toBe(1);
    expect(getRepoApprovedCount(data, "c", "d")).toBe(4);
    expect(data.reviewRequests?.issueCount).toBe(2);
  });

  it("sends every query, including each approved chunk", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(
        async () => new Response(JSON.stringify({ data: {} }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);
    await fetchGitHubData("tok", queries);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("fails the whole fetch when one query fails", async () => {
    // A dropped chunk would leave a repo's approved count at zero, which the
    // panel renders as "nothing to merge" rather than as an error.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body: string }) => {
        const { query } = JSON.parse(init.body) as { query: string };
        return query === "approved1"
          ? new Response("nope", { status: 401 })
          : new Response(JSON.stringify({ data: {} }), { status: 200 });
      }),
    );
    await expect(fetchGitHubData("tok", queries)).rejects.toThrow(
      /GitHub API 401/,
    );
  });
});

describe("getRepoOpenCount", () => {
  const baseData: RawGitHubResponse = {
    viewer: { login: "tester" },
    myOpenPRs: { nodes: [] },
  };

  it("returns the totalCount when present", () => {
    const data: RawGitHubResponse = {
      ...baseData,
      [repoAlias("Acme", "alpha")]: { pullRequests: { totalCount: 7 } },
    };
    expect(getRepoOpenCount(data, "Acme", "alpha")).toBe(7);
  });

  it("returns 0 for a repo not present in the response", () => {
    expect(getRepoOpenCount(baseData, "Acme", "missing")).toBe(0);
  });

  it("returns 0 when alias key exists but pullRequests is missing", () => {
    const data: RawGitHubResponse = {
      ...baseData,
      [repoAlias("Acme", "broken")]: {},
    };
    expect(getRepoOpenCount(data, "Acme", "broken")).toBe(0);
  });
});

describe("getRepoWipCount", () => {
  const baseData: RawGitHubResponse = {
    viewer: { login: "tester" },
    myOpenPRs: { nodes: [] },
  };

  it("returns the wip totalCount when present", () => {
    const data: RawGitHubResponse = {
      ...baseData,
      [repoAlias("Acme", "alpha")]: {
        pullRequests: { totalCount: 7 },
        wip: { totalCount: 3 },
      },
    };
    expect(getRepoWipCount(data, "Acme", "alpha")).toBe(3);
  });

  it("returns 0 for a repo not present in the response", () => {
    expect(getRepoWipCount(baseData, "Acme", "missing")).toBe(0);
  });

  it("returns 0 when alias key exists but wip is missing", () => {
    const data: RawGitHubResponse = {
      ...baseData,
      [repoAlias("Acme", "nowip")]: { pullRequests: { totalCount: 4 } },
    };
    expect(getRepoWipCount(data, "Acme", "nowip")).toBe(0);
  });
});

describe("getRepoApprovedCount", () => {
  const baseData: RawGitHubResponse = {
    viewer: { login: "tester" },
    myOpenPRs: { nodes: [] },
  };

  it("reads issueCount from the repo's own approved search", () => {
    const data: RawGitHubResponse = {
      ...baseData,
      [approvedAlias("Acme", "alpha")]: { issueCount: 5 },
    };
    expect(getRepoApprovedCount(data, "Acme", "alpha")).toBe(5);
  });

  it("returns 0 for a repo not present in the response", () => {
    expect(getRepoApprovedCount(baseData, "Acme", "missing")).toBe(0);
  });

  it("does not read the count off the repository block", () => {
    // The two live under different keys on purpose: `search` is a Query field
    // and doesn't exist on Repository, so a count found there would be a bug.
    const data: RawGitHubResponse = {
      ...baseData,
      [repoAlias("Acme", "beta")]: {
        pullRequests: { totalCount: 9 },
        approved: { issueCount: 9 },
      },
    };
    expect(getRepoApprovedCount(data, "Acme", "beta")).toBe(0);
  });
});

describe("approvedAlias", () => {
  it("is a valid GraphQL alias and distinct from the repository block's", () => {
    const alias = approvedAlias("Acme", "forms-app");
    expect(alias).toMatch(/^[a-zA-Z_][a-zA-Z0-9_]*$/);
    expect(alias).not.toBe(repoAlias("Acme", "forms-app"));
  });
});
