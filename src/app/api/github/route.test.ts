import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "@/types";

/**
 * Route-level tests. These cover the wiring the pure lib tests can't reach:
 * missing-token handling, how config flows into the query, and how upstream
 * failures are turned into responses. `readConfig` reads the filesystem and the
 * fetch talks to GitHub, so both are replaced here.
 */

const config = (over: Partial<AppConfig> = {}): AppConfig => ({
  repos: [
    { owner: "Northwind", name: "billing-app" },
    { owner: "Northwind", name: "forms-app" },
  ],
  linear: {
    teamKey: "ENG",
  },
  refreshIntervalSeconds: 300,
  ...over,
});

const readConfig = vi.hoisted(() => vi.fn());
vi.mock("@/lib/config", () => ({ readConfig }));

/** One PR node as GitHub's search returns it; only the fields under test differ. */
function prNode(over: Record<string, unknown> = {}) {
  return {
    number: 1,
    title: "a change",
    url: "https://github.com/Northwind/billing-app/pull/1",
    isDraft: false,
    createdAt: "2026-07-01T00:00:00Z",
    reviewDecision: null,
    headRefName: "someone/eng-1-a-change",
    repository: { nameWithOwner: "Northwind/billing-app" },
    labels: { nodes: [] },
    author: { login: "teammate" },
    additions: 10,
    deletions: 2,
    ...over,
  };
}

/** Minimal well-formed GitHub GraphQL payload. */
function ghPayload(over: Record<string, unknown> = {}) {
  return {
    viewer: { login: "alexdoe" },
    myOpenPRs: { nodes: [] },
    reviewRequests: { issueCount: 0, nodes: [] },
    repo_Northwind_billing_app: {
      pullRequests: { totalCount: 4 },
      wip: { totalCount: 1 },
    },
    repo_Northwind_forms_app: {
      pullRequests: { totalCount: 2 },
      wip: { totalCount: 0 },
    },
    // Approved counts are their own root-level searches, not fields on the
    // repository block - `search` doesn't exist on Repository.
    approved_repo_Northwind_billing_app: { issueCount: 2 },
    approved_repo_Northwind_forms_app: { issueCount: 0 },
    ...over,
  };
}

/**
 * Every query the route sent, joined.
 *
 * The panel is several parallel queries rather than one - see
 * buildGitHubQueries - so an assertion about "the query" belongs against the
 * set, not against whichever request happened to resolve first.
 */
function sent(calls: Array<{ query: string }>): string {
  return calls.map((c) => c.query).join("\n");
}

/** Stubs fetch with one JSON body, recording each request for assertions. */
function stubFetch(body: unknown, ok = true, status = 200) {
  const calls: Array<{ url: string; query: string; headers: Record<string, string> }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { body: string; headers: Record<string, string> }) => {
      calls.push({ url, query: JSON.parse(init.body).query, headers: init.headers });
      return {
        ok,
        status,
        json: async () => body,
        text: async () => JSON.stringify(body),
      };
    }),
  );
  return calls;
}

async function callGET() {
  const { GET } = await import("@/app/api/github/route");
  return GET();
}

beforeEach(() => {
  vi.resetModules();
  readConfig.mockResolvedValue(config());
  vi.stubEnv("GITHUB_TOKEN", "gh-test-token");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  readConfig.mockReset();
});

describe("GET /api/github", () => {
  it("500s with an actionable message when the token is missing", async () => {
    vi.stubEnv("GITHUB_TOKEN", "");
    const res = await callGET();
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({
      error: "GITHUB_TOKEN is not set in .env.local",
    });
  });

  it("does not call GitHub at all when the token is missing", async () => {
    vi.stubEnv("GITHUB_TOKEN", "");
    const calls = stubFetch(ghPayload());
    await callGET();
    expect(calls).toHaveLength(0);
  });

  it("returns per-repo open and WIP counts for every configured repo", async () => {
    stubFetch({ data: ghPayload() });
    const res = await callGET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.viewer).toBe("alexdoe");
    expect(body.teamPRsByRepo).toEqual([
      { repo: "Northwind/billing-app", openCount: 4, wipCount: 1, approvedCount: 2 },
      { repo: "Northwind/forms-app", openCount: 2, wipCount: 0, approvedCount: 0 },
    ]);
  });

  it("names a repo GitHub couldn't find instead of failing the whole panel", async () => {
    // Misspelled in config.json, or invisible to the token: GitHub answers the
    // rest of the query and returns that block as null with a NOT_FOUND error.
    stubFetch({
      data: ghPayload({ repo_Northwind_forms_app: null }),
      errors: [{ type: "NOT_FOUND", path: ["repo_Northwind_forms_app"] }],
    });
    const res = await callGET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.unavailableRepos).toEqual(["Northwind/forms-app"]);
    expect(body.teamPRsByRepo).toContainEqual(
      expect.objectContaining({ repo: "Northwind/billing-app", openCount: 4 }),
    );
  });

  it("keeps repos the response had no data for, reporting zeros", async () => {
    // A repo the token can't read comes back absent, not as an error.
    stubFetch({
      data: ghPayload({
        repo_Northwind_forms_app: undefined,
        approved_repo_Northwind_forms_app: undefined,
      }),
    });
    const body = await (await callGET()).json();
    expect(body.teamPRsByRepo).toContainEqual({
      repo: "Northwind/forms-app",
      openCount: 0,
      wipCount: 0,
      approvedCount: 0,
    });
  });

  it("sends the bearer token and never leaks it into the response", async () => {
    const calls = stubFetch({ data: ghPayload() });
    const res = await callGET();
    expect(calls[0].headers.Authorization).toBe("Bearer gh-test-token");
    expect(JSON.stringify(await res.json())).not.toContain("gh-test-token");
  });

  it("queries every configured repo", async () => {
    const calls = stubFetch({ data: ghPayload() });
    await callGET();
    expect(sent(calls)).toContain('owner: "Northwind", name: "billing-app"');
    expect(sent(calls)).toContain('owner: "Northwind", name: "forms-app"');
  });

  it("splits the panel across several parallel queries", async () => {
    // One query holding all of this measured 12.6s against GitHub's ~10s
    // ceiling and 502'd on every refresh - the split is what makes the panel
    // work at all, so a route that went back to a single fetch is a regression.
    const calls = stubFetch({ data: ghPayload() });
    await callGET();
    expect(calls.length).toBeGreaterThan(1);
    for (const call of calls) {
      expect(call.query).not.toMatch(/query\s*\{\s*\}/);
    }
  });

  it("scopes both PR searches to the configured repos", async () => {
    const calls = stubFetch({ data: ghPayload() });
    await callGET();
    // Counting the whole scope string rather than one repo: the per-repo
    // approved searches each carry a lone `repo:` qualifier of their own, so
    // counting a single repo name now measures those too. The full scope appears
    // once per scoped search and nowhere else.
    const fullScope = /repo:Northwind\/billing-app repo:Northwind\/forms-app/g;
    expect(sent(calls).match(fullScope)).toHaveLength(2);
  });

  it("gives every configured repo its own approved-PR search", async () => {
    const calls = stubFetch({ data: ghPayload() });
    await callGET();
    expect(sent(calls)).toContain(
      'approved_repo_Northwind_billing_app: search(query: "repo:Northwind/billing-app is:pr is:open review:approved"',
    );
    expect(sent(calls)).toContain(
      'approved_repo_Northwind_forms_app: search(query: "repo:Northwind/forms-app is:pr is:open review:approved"',
    );
    // issueCount, not totalCount: a search connection has no totalCount, and
    // asking for one fails the whole query rather than just this field.
    expect(sent(calls)).not.toMatch(/approved_repo_\w+: search\([^)]*\) \{\s*totalCount/);
  });

  it("drops one of the viewer's own PRs from a repo that isn't configured", async () => {
    // The search qualifiers already exclude these; this is the second line of
    // defence, and the reason personal work stopped appearing in the panel.
    stubFetch({
      data: ghPayload({
        myOpenPRs: {
          nodes: [
            prNode({ number: 1 }),
            prNode({
              number: 2,
              repository: { nameWithOwner: "sam/side-project" },
            }),
          ],
        },
      }),
    });
    const body = await (await callGET()).json();
    expect(body.myPRs.map((p: { number: number }) => p.number)).toEqual([1]);
  });

  it("passes a queued PR's merge-queue entry through to the row", async () => {
    // A queued PR as GitHub returns it: queued, yet mergeStateStatus CLEAN.
    // The route has to carry both, or the badge goes back to "ready to merge".
    stubFetch({
      data: ghPayload({
        myOpenPRs: {
          nodes: [
            prNode({
              number: 1,
              mergeStateStatus: "CLEAN",
              isInMergeQueue: true,
              mergeQueueEntry: { state: "AWAITING_CHECKS", position: 1 },
            }),
          ],
        },
      }),
    });
    const body = await (await callGET()).json();
    expect(body.myPRs[0]).toMatchObject({
      mergeStateStatus: "CLEAN",
      mergeQueue: { state: "AWAITING_CHECKS", position: 1 },
    });
  });

  it("reports no merge queue on a repo that has none", async () => {
    // A repo without a queue omits both fields entirely, and that has to arrive
    // as null rather than undefined — true of any repo, not a fixed list.
    stubFetch({ data: ghPayload({ myOpenPRs: { nodes: [prNode({ number: 1 })] } }) });
    const body = await (await callGET()).json();
    expect(body.myPRs[0].mergeQueue).toBeNull();
  });

  it("marks a PR from a fork, and asks GitHub for the field", async () => {
    const calls = stubFetch({
      data: ghPayload({
        myOpenPRs: {
          nodes: [prNode({ number: 1, isCrossRepository: true }), prNode({ number: 2 })],
        },
      }),
    });
    const body = await (await callGET()).json();
    expect(body.myPRs.map((p: { isCrossRepository: boolean }) => p.isCrossRepository)).toEqual([
      true,
      false,
    ]);
    expect(sent(calls)).toContain("isCrossRepository");
  });

  it("shows no PRs at all when no repos are configured", async () => {
    // An empty repo list makes the scope qualifiers empty, so the search comes
    // back unrestricted — the panel must still not show your whole account.
    readConfig.mockResolvedValue(config({ repos: [] }));
    stubFetch({
      data: {
        viewer: { login: "alexdoe" },
        myOpenPRs: { nodes: [prNode({ number: 1 })] },
        reviewRequests: { issueCount: 1, nodes: [prNode({ number: 2 })] },
      },
    });
    const body = await (await callGET()).json();
    expect(body.myPRs).toEqual([]);
    expect(body.reviewRequests).toEqual([]);
    expect(body.reviewRequestTotal).toBe(0);
  });

  it("defaults the WIP label to 'wip' when config omits it", async () => {
    const calls = stubFetch({ data: ghPayload() });
    const body = await (await callGET()).json();
    expect(body.wipLabel).toBe("wip");
    expect(calls[0].query).toContain('labels: ["wip"]');
  });

  it("uses a configured wipLabel instead", async () => {
    readConfig.mockResolvedValue(config({ wipLabel: "in-progress" }));
    const calls = stubFetch({ data: ghPayload() });
    const body = await (await callGET()).json();
    expect(body.wipLabel).toBe("in-progress");
    expect(calls[0].query).toContain('labels: ["in-progress"]');
  });

  it("flags the viewer's own PRs carrying the WIP label", async () => {
    stubFetch({
      data: ghPayload({
        myOpenPRs: {
          nodes: [
            {
              number: 1,
              title: "wip one",
              url: "u1",
              isDraft: false,
              createdAt: "2026-07-01T00:00:00Z",
              reviewDecision: null,
              repository: { nameWithOwner: "Northwind/billing-app" },
              labels: { nodes: [{ name: "WIP" }] },
            },
            {
              number: 2,
              title: "ready",
              url: "u2",
              isDraft: false,
              createdAt: "2026-07-02T00:00:00Z",
              reviewDecision: "APPROVED",
              repository: { nameWithOwner: "Northwind/billing-app" },
              labels: { nodes: [] },
            },
          ],
        },
      }),
    });
    const body = await (await callGET()).json();
    expect(body.myPRs.map((p: { number: number; isWip: boolean }) => [p.number, p.isWip])).toEqual(
      [
        [1, true], // matched case-insensitively
        [2, false],
      ],
    );
  });

  // Wiring, not maths: toCIState's own rules are tested in view.test.ts. What
  // this pins is that the counts are read off the same rollup as the state, on
  // both lists — reading only the state is the bug that shipped.
  it("passes the rollup's counts to ciState, not just its state", async () => {
    const rollup = {
      commits: {
        nodes: [
          {
            commit: {
              statusCheckRollup: {
                state: "FAILURE",
                contexts: {
                  checkRunCountsByState: [
                    { state: "SUCCESS", count: 28 },
                    { state: "SKIPPED", count: 2 },
                    { state: "CANCELLED", count: 1 },
                  ],
                  statusContextCountsByState: [{ state: "SUCCESS", count: 1 }],
                },
              },
            },
          },
        ],
      },
    };
    const node = (number: number) => ({
      number,
      title: "t",
      url: "u",
      isDraft: false,
      createdAt: "2026-07-01T00:00:00Z",
      reviewDecision: null,
      repository: { nameWithOwner: "Northwind/billing-app" },
      labels: { nodes: [] },
      ...rollup,
    });
    stubFetch({
      data: ghPayload({
        myOpenPRs: { nodes: [node(1)] },
        reviewRequests: { issueCount: 1, nodes: [node(2)] },
      }),
    });
    const body = await (await callGET()).json();
    expect(body.myPRs[0].ciState).toBe("CANCELLED");
    expect(body.reviewRequests[0].ciState).toBe("CANCELLED");
  });

  // Also wiring: the suites sit beside the rollup on the commit, not inside it,
  // so they are easy to read from the wrong place or drop on one of the two
  // lists. The counts here say FAILURE on their own — only the suites, threaded
  // through with the createdAt that supersedes the cancelled run, turn this
  // green.
  it("passes the commit's check suites to ciState on both lists", async () => {
    const commit = {
      commits: {
        nodes: [
          {
            commit: {
              checkSuites: {
                totalCount: 2,
                nodes: [
                  {
                    conclusion: "CANCELLED",
                    status: "COMPLETED",
                    createdAt: "2026-08-07T10:00:00Z",
                    app: { slug: "github-actions" },
                    workflowRun: { workflow: { id: "pull-request" } },
                  },
                  {
                    conclusion: "SUCCESS",
                    status: "COMPLETED",
                    createdAt: "2026-08-07T11:00:00Z",
                    app: { slug: "github-actions" },
                    workflowRun: { workflow: { id: "pull-request" } },
                  },
                ],
              },
              statusCheckRollup: {
                state: "FAILURE",
                contexts: {
                  checkRunCountsByState: [
                    { state: "SUCCESS", count: 29 },
                    { state: "FAILURE", count: 1 },
                    { state: "CANCELLED", count: 1 },
                  ],
                  statusContextCountsByState: [],
                },
              },
            },
          },
        ],
      },
    };
    const node = (number: number) => ({
      number,
      title: "t",
      url: "u",
      isDraft: false,
      createdAt: "2026-07-01T00:00:00Z",
      reviewDecision: null,
      repository: { nameWithOwner: "Northwind/billing-app" },
      labels: { nodes: [] },
      ...commit,
    });
    stubFetch({
      data: ghPayload({
        myOpenPRs: { nodes: [node(1)] },
        reviewRequests: { issueCount: 1, nodes: [node(2)] },
      }),
    });
    const body = await (await callGET()).json();
    expect(body.myPRs[0].ciState).toBe("SUCCESS");
    expect(body.reviewRequests[0].ciState).toBe("SUCCESS");
  });

  it("skips malformed search nodes rather than crashing", async () => {
    stubFetch({
      data: ghPayload({
        myOpenPRs: { nodes: [null, { __typename: "Issue" }] },
      }),
    });
    const res = await callGET();
    expect(res.status).toBe(200);
    expect((await res.json()).myPRs).toEqual([]);
  });

  it("returns PRs awaiting the viewer's review, oldest first", async () => {
    stubFetch({
      data: ghPayload({
        reviewRequests: {
          issueCount: 3,
          nodes: [
            prNode({ number: 5, createdAt: "2026-07-10T00:00:00Z" }),
            prNode({ number: 6, createdAt: "2026-07-02T00:00:00Z" }),
            prNode({ number: 7, createdAt: "2026-07-06T00:00:00Z" }),
          ],
        },
      }),
    });
    const body = await (await callGET()).json();
    expect(body.reviewRequests.map((p: { number: number }) => p.number)).toEqual([
      6, 7, 5,
    ]);
    expect(body.reviewRequestTotal).toBe(3);
  });

  it("carries the author and diff size for each review request", async () => {
    stubFetch({
      data: ghPayload({
        reviewRequests: {
          issueCount: 1,
          nodes: [prNode({ author: { login: "dana" }, additions: 431, deletions: 17 })],
        },
      }),
    });
    const body = await (await callGET()).json();
    expect(body.reviewRequests[0]).toMatchObject({
      repo: "Northwind/billing-app",
      author: "dana",
      additions: 431,
      deletions: 17,
    });
  });

  it("drops a review request from a repo that isn't configured", async () => {
    stubFetch({
      data: ghPayload({
        reviewRequests: {
          issueCount: 2,
          nodes: [
            prNode({ number: 8 }),
            prNode({
              number: 9,
              repository: { nameWithOwner: "OtherOrg/some-tool" },
            }),
          ],
        },
      }),
    });
    const body = await (await callGET()).json();
    expect(body.reviewRequests.map((p: { number: number }) => p.number)).toEqual([8]);
  });

  it("stops trusting issueCount once the repo filter has dropped something", async () => {
    // The subtitle reads "N of M waiting". issueCount counts what the search
    // matched, which is no longer what we're showing.
    stubFetch({
      data: ghPayload({
        reviewRequests: {
          issueCount: 60,
          nodes: [
            prNode({ number: 8 }),
            prNode({
              number: 9,
              repository: { nameWithOwner: "OtherOrg/some-tool" },
            }),
          ],
        },
      }),
    });
    const body = await (await callGET()).json();
    expect(body.reviewRequestTotal).toBe(1);
  });

  it("keeps issueCount as the total when nothing was filtered out", async () => {
    // Otherwise a queue longer than the page size would silently under-report.
    stubFetch({
      data: ghPayload({
        reviewRequests: { issueCount: 60, nodes: [prNode({ number: 8 })] },
      }),
    });
    const body = await (await callGET()).json();
    expect(body.reviewRequestTotal).toBe(60);
  });

  it("tolerates a deleted author and missing diff counts", async () => {
    stubFetch({
      data: ghPayload({
        reviewRequests: {
          issueCount: 1,
          nodes: [prNode({ author: null, additions: undefined, deletions: undefined })],
        },
      }),
    });
    const body = await (await callGET()).json();
    expect(body.reviewRequests[0]).toMatchObject({
      author: "",
      additions: 0,
      deletions: 0,
    });
  });

  it("flags a WIP-labelled review request using the configured label", async () => {
    readConfig.mockResolvedValue(config({ wipLabel: "in-progress" }));
    stubFetch({
      data: ghPayload({
        reviewRequests: {
          issueCount: 1,
          nodes: [prNode({ labels: { nodes: [{ name: "In-Progress" }] } })],
        },
      }),
    });
    const body = await (await callGET()).json();
    expect(body.reviewRequests[0].isWip).toBe(true);
  });

  it("skips malformed review-request nodes rather than crashing", async () => {
    stubFetch({
      data: ghPayload({
        reviewRequests: {
          issueCount: 2,
          nodes: [null, { __typename: "Issue" }, prNode({ number: 4 })],
        },
      }),
    });
    const res = await callGET();
    expect(res.status).toBe(200);
    expect((await res.json()).reviewRequests.map((p: { number: number }) => p.number)).toEqual([4]);
  });

  it("falls back to the fetched count when GitHub omits issueCount", async () => {
    // The subtitle reads "N of M waiting"; M must never be a number we invented.
    stubFetch({
      data: ghPayload({ reviewRequests: { nodes: [prNode()] } }),
    });
    const body = await (await callGET()).json();
    expect(body.reviewRequestTotal).toBe(1);
  });

  it("reports an empty review queue rather than omitting the field", async () => {
    stubFetch({ data: ghPayload({ reviewRequests: undefined }) });
    const body = await (await callGET()).json();
    expect(body.reviewRequests).toEqual([]);
    expect(body.reviewRequestTotal).toBe(0);
  });

  it("500s with the upstream status when GitHub rejects the request", async () => {
    stubFetch({ message: "Bad credentials" }, false, 401);
    const res = await callGET();
    expect(res.status).toBe(500);
    expect((await res.json()).error).toContain("GitHub API 401");
  });

  it("500s when GitHub returns GraphQL errors", async () => {
    stubFetch({ errors: [{ message: "Something went wrong" }] });
    const res = await callGET();
    expect(res.status).toBe(500);
    expect((await res.json()).error).toContain("GitHub GraphQL errors");
  });

  it("surfaces a config error instead of throwing", async () => {
    readConfig.mockRejectedValue(new Error("config.json not found"));
    const res = await callGET();
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("config.json not found");
  });

  it("handles an empty repo list without calling for repo blocks", async () => {
    readConfig.mockResolvedValue(config({ repos: [] }));
    stubFetch({ data: { viewer: { login: "alexdoe" }, myOpenPRs: { nodes: [] } } });
    const res = await callGET();
    expect(res.status).toBe(200);
    expect((await res.json()).teamPRsByRepo).toEqual([]);
  });
});
