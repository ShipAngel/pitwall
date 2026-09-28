import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "@/types";

/**
 * Route-level tests: the wiring, the gates, and the order of the writes.
 *
 * The rules themselves live in `lib/startWork.test.ts`. What matters here is
 * that nothing is written before the guards pass, that a second run doesn't open
 * a second PR, and that a Linear failure after the PR exists is reported without
 * losing the PR.
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

/** The Linear issue as the start-work query returns it. */
function issue(over: Record<string, unknown> = {}) {
  return {
    id: "uuid-1",
    identifier: "ENG-1",
    title: "Fix the thing",
    url: "https://linear.app/x/issue/ENG-1",
    branchName: "alex/eng-1-fix-the-thing",
    assignee: null,
    state: { id: "s-backlog", name: "Backlog", type: "backlog" },
    team: {
      key: "ENG",
      states: {
        nodes: [
          { id: "s-backlog", name: "Backlog" },
          { id: "s-progress", name: "In Progress" },
        ],
      },
    },
    ...over,
  };
}

type Reply = { status?: number; body?: unknown; json?: unknown };

/**
 * One queue of replies across both APIs, matched by URL so a test only has to
 * describe the responses it cares about.
 *
 * Linear goes through `fetchLinearGraphQL` (reads `.json()`), GitHub's REST
 * layer reads `.text()` — both are provided on every reply.
 */
function stubFetch(handler: (url: string, body: unknown) => Reply) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { method?: string; body?: string }) => {
      const body = init.body ? JSON.parse(init.body) : undefined;
      calls.push({ url, method: init.method ?? "GET", body });
      const reply = handler(url, body);
      const status = reply.status ?? 200;
      const payload = reply.body ?? reply.json ?? null;
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => payload,
        text: async () => (payload === null ? "" : JSON.stringify(payload)),
      };
    }),
  );
  return calls;
}

/** The happy path: unassigned backlog ticket, no branch, no PR. */
function happyPath(over: { issue?: Record<string, unknown>; existingPRs?: unknown[]; branch404?: boolean } = {}) {
  return (url: string, reqBody?: unknown) => {
    if (url.includes("linear.app")) {
      // The read and the write share an endpoint, so they are told apart by the
      // document — the mutation must not be answered with the query's payload.
      const query = String((reqBody as { query?: string } | undefined)?.query ?? "");
      if (query.includes("issueUpdate")) {
        return { body: { data: { issueUpdate: { success: true } } } };
      }
      return { body: { data: { viewer: { id: "me", name: "Me" }, issue: issue(over.issue) } } };
    }
    if (url.includes("/pulls?")) return { body: over.existingPRs ?? [] };
    if (url.includes("/git/ref/heads/")) {
      return over.branch404 === false
        ? { body: { ref: "x" } }
        : { status: 404, body: { message: "Not Found" } };
    }
    if (url.includes("/git/commits")) return { body: { sha: "new-sha" } };
    if (url.includes("/git/refs")) return { body: {} };
    if (url.includes("/commits/")) {
      return { body: { sha: "base-sha", commit: { tree: { sha: "base-tree" } } } };
    }
    if (url.endsWith("/pulls")) return { body: { number: 42, html_url: "https://gh/pr/42" } };
    return { body: { default_branch: "main" } };
  };
}

async function callPOST(body: unknown, headers: Record<string, string> = {}) {
  const { POST } = await import("@/app/api/start-work/route");
  return POST(
    new Request("http://localhost:3737/api/start-work", {
      method: "POST",
      headers: { origin: "http://localhost:3737", host: "localhost:3737", ...headers },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  vi.resetModules();
  readConfig.mockResolvedValue(config());
  vi.stubEnv("GITHUB_TOKEN", "gh-test-token");
  vi.stubEnv("LINEAR_API_KEY", "lin-test-key");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  readConfig.mockReset();
});

describe("POST /api/start-work", () => {
  it("assigns, branches and opens a draft PR", async () => {
    const calls = stubFetch(happyPath());
    const res = await callPOST({ ticketId: "ENG-1", repo: "Northwind/billing-app" });
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.started).toBe(true);
    expect(body.prCreated).toBe(true);
    expect(body.assigned).toBe(true);
    expect(body.statusMoved).toBe(true);
    expect(body.pr).toEqual({
      url: "https://gh/pr/42",
      number: 42,
      repo: "Northwind/billing-app",
      branch: "alex/eng-1-fix-the-thing",
    });

    const pr = calls.find((c) => c.method === "POST" && c.url.endsWith("/pulls"));
    expect(pr?.body).toMatchObject({ draft: true, base: "main", head: "alex/eng-1-fix-the-thing" });
    expect((pr?.body as { title: string }).title).toBe("[ENG-1] Fix the thing");
  });

  it("uses the branch name Linear gave, not one it made up", async () => {
    const calls = stubFetch(happyPath({ issue: { branchName: "alex/eng-1-custom" } }));
    await callPOST({ ticketId: "ENG-1", repo: "Northwind/billing-app" });
    const ref = calls.find((c) => c.url.includes("/git/refs") && c.method === "POST");
    expect(ref?.body).toEqual({ ref: "refs/heads/alex/eng-1-custom", sha: "new-sha" });
  });

  it("sends one Linear mutation carrying both the assignee and the state", async () => {
    const calls = stubFetch(happyPath());
    await callPOST({ ticketId: "ENG-1", repo: "Northwind/billing-app" });
    const mutations = calls.filter(
      (c) => c.url.includes("linear.app") && String((c.body as { query: string }).query).includes("issueUpdate"),
    );
    expect(mutations).toHaveLength(1);
    expect((mutations[0].body as { variables: unknown }).variables).toEqual({
      id: "uuid-1",
      input: { assigneeId: "me", stateId: "s-progress" },
    });
  });

  it("normalizes a sloppy ticket id before looking it up", async () => {
    const calls = stubFetch(happyPath());
    await callPOST({ ticketId: " eng 1 ", repo: "Northwind/billing-app" });
    const query = calls.find((c) => c.url.includes("linear.app"));
    expect((query?.body as { variables: { id: string } }).variables.id).toBe("ENG-1");
  });

  // The whole point of the refusal: one transposed digit must not push a branch
  // and open a PR on a colleague's ticket.
  it("refuses a ticket assigned to someone else, writing nothing", async () => {
    const calls = stubFetch(
      happyPath({ issue: { assignee: { id: "sam", name: "Sam" } } }),
    );
    const res = await callPOST({ ticketId: "ENG-1", repo: "Northwind/billing-app" });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.started).toBe(false);
    expect(body.error).toContain("Sam");
    expect(calls.filter((c) => c.method === "POST" && !c.url.includes("linear.app"))).toEqual([]);
    expect(calls.filter((c) => c.url.includes("api.github.com"))).toEqual([]);
  });

  it("proceeds on a ticket already assigned to you, without reassigning", async () => {
    stubFetch(happyPath({ issue: { assignee: { id: "me", name: "Me" } } }));
    const body = await (await callPOST({ ticketId: "ENG-1", repo: "Northwind/billing-app" })).json();
    expect(body.started).toBe(true);
    expect(body.assigned).toBe(false);
    expect(body.notes.join(" ")).toContain("already assigned to you");
  });

  // Running it twice is the ordinary case — an interrupted first run, or a second
  // click. It must find the PR rather than fail on a duplicate.
  it("returns the existing PR instead of opening a second one", async () => {
    const calls = stubFetch(
      happyPath({ existingPRs: [{ number: 7, html_url: "https://gh/pr/7" }] }),
    );
    const body = await (await callPOST({ ticketId: "ENG-1", repo: "Northwind/billing-app" })).json();
    expect(body.started).toBe(true);
    expect(body.prCreated).toBe(false);
    expect(body.pr.number).toBe(7);
    expect(body.notes.join(" ")).toContain("already open");
    expect(calls.find((c) => c.method === "POST" && c.url.endsWith("/pulls"))).toBeUndefined();
    expect(calls.find((c) => c.url.includes("/git/commits"))).toBeUndefined();
  });

  it("reuses a branch that already exists rather than recreating it", async () => {
    const calls = stubFetch(happyPath({ branch404: false }));
    const body = await (await callPOST({ ticketId: "ENG-1", repo: "Northwind/billing-app" })).json();
    expect(body.started).toBe(true);
    expect(body.prCreated).toBe(true);
    expect(body.notes.join(" ")).toContain("already existed");
    expect(calls.find((c) => c.url.includes("/git/commits"))).toBeUndefined();
  });

  // The PR is the artefact worth having. A Linear write failing afterwards is
  // reported, not rolled back into a failure that hides the PR's existence.
  it("keeps the PR when the Linear update fails, and says what happened", async () => {
    stubFetch((url, body) => {
      if (url.includes("linear.app")) {
        const query = String((body as { query: string }).query);
        if (query.includes("issueUpdate")) {
          return { body: { errors: [{ message: "nope" }] } };
        }
        return { body: { data: { viewer: { id: "me", name: "Me" }, issue: issue() } } };
      }
      return happyPath()(url, body);
    });
    const res = await callPOST({ ticketId: "ENG-1", repo: "Northwind/billing-app" });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.started).toBe(true);
    expect(json.pr.number).toBe(42);
    expect(json.assigned).toBe(false);
    expect(json.statusMoved).toBe(false);
    expect(json.notes.join(" ")).toContain("The PR is open");
  });

  it("reports Linear's own sentence for an unknown ticket", async () => {
    stubFetch(() => ({
      body: {
        errors: [
          {
            message: "Entity not found: Issue",
            extensions: { userPresentableMessage: "Could not find referenced Issue." },
          },
        ],
      },
    }));
    const res = await callPOST({ ticketId: "ENG-999", repo: "Northwind/billing-app" });
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("No Linear issue ENG-999.");
  });

  it("notes a ticket from another team rather than refusing it", async () => {
    stubFetch(happyPath({ issue: { team: { key: "OPS", states: { nodes: [] } } } }));
    const body = await (await callPOST({ ticketId: "ENG-1", repo: "Northwind/billing-app" })).json();
    expect(body.started).toBe(true);
    expect(body.notes.join(" ")).toContain("belongs to team OPS");
  });

  it("refuses a repo that isn't in config.json", async () => {
    const calls = stubFetch(happyPath());
    const res = await callPOST({ ticketId: "ENG-1", repo: "OtherOrg/thing" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("not in config.json");
    expect(calls).toEqual([]);
  });

  it("refuses an unparseable ticket id before calling anything", async () => {
    const calls = stubFetch(happyPath());
    const res = await callPOST({ ticketId: "nonsense", repo: "Northwind/billing-app" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("ENG-1234");
    expect(calls).toEqual([]);
  });

  it("writes nothing to Linear when opening the PR fails", async () => {
    // GitHub first, Linear second, is the order that keeps a failure harmless:
    // reversed, a GitHub error would leave the ticket assigned and moved with
    // nothing to show for it. Nothing else pins that order.
    const happy = happyPath();
    const calls = stubFetch((url, body) =>
      url.endsWith("/pulls")
        ? { status: 422, body: { message: "Validation Failed" } }
        : happy(url, body),
    );
    const res = await callPOST({ ticketId: "ENG-1", repo: "Northwind/billing-app" });
    expect(res.ok).toBe(false);
    const mutations = calls.filter(
      (c) => c.url.includes("linear.app") && String((c.body as { query?: string })?.query).includes("issueUpdate"),
    );
    expect(mutations).toEqual([]);
  });

  it("refuses a cross-origin request", async () => {
    const calls = stubFetch(happyPath());
    const res = await callPOST(
      { ticketId: "ENG-1", repo: "Northwind/billing-app" },
      { origin: "http://evil.example" },
    );
    expect(res.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it("refuses a DNS-rebinding request, where Origin and Host match but aren't local", async () => {
    const calls = stubFetch(happyPath());
    const res = await callPOST(
      { ticketId: "ENG-1", repo: "Northwind/billing-app" },
      { origin: "http://evil.example:3737", host: "evil.example:3737" },
    );
    expect(res.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it("refuses a body that isn't { ticketId, repo }", async () => {
    stubFetch(happyPath());
    const res = await callPOST({ ticketId: "ENG-1" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("Expected { ticketId, repo }");
  });

  it("500s with an actionable message when a token is missing", async () => {
    vi.stubEnv("LINEAR_API_KEY", "");
    const calls = stubFetch(happyPath());
    const res = await callPOST({ ticketId: "ENG-1", repo: "Northwind/billing-app" });
    expect(res.status).toBe(500);
    expect((await res.json()).error).toContain("LINEAR_API_KEY");
    expect(calls).toEqual([]);
  });

  it("never leaks a token into the response", async () => {
    stubFetch(happyPath());
    const res = await callPOST({ ticketId: "ENG-1", repo: "Northwind/billing-app" });
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain("gh-test-token");
    expect(text).not.toContain("lin-test-key");
  });

  it("uses a configured inProgressStatusName", async () => {
    readConfig.mockResolvedValue(
      config({
        linear: {
          teamKey: "ENG",
          inProgressStatusName: "Doing",
        },
      }),
    );
    const calls = stubFetch(
      happyPath({
        issue: {
          team: {
            key: "ENG",
            states: { nodes: [{ id: "s-doing", name: "Doing" }] },
          },
        },
      }),
    );
    const body = await (await callPOST({ ticketId: "ENG-1", repo: "Northwind/billing-app" })).json();
    expect(body.statusMoved).toBe(true);
    const mutation = calls.find(
      (c) => c.url.includes("linear.app") && String((c.body as { query: string }).query).includes("issueUpdate"),
    );
    expect((mutation?.body as { variables: { input: unknown } }).variables.input).toMatchObject({
      stateId: "s-doing",
    });
  });

  it("refuses a branch name Linear couldn't give", async () => {
    const calls = stubFetch(happyPath({ issue: { branchName: "" } }));
    const res = await callPOST({ ticketId: "ENG-1", repo: "Northwind/billing-app" });
    expect(res.status).toBe(502);
    expect(calls.filter((c) => c.url.includes("api.github.com"))).toEqual([]);
  });

  // The empty case above is caught by the `!branch` check alone, so on its own it
  // would pass with `isValidBranchName` deleted. This one is what holds that
  // guard in place — ".." is rejected by git and by isValidBranchName.
  it("refuses a branch name that isn't a usable git ref", async () => {
    const calls = stubFetch(happyPath({ issue: { branchName: "alex/eng-1..bad" } }));
    const res = await callPOST({ ticketId: "ENG-1", repo: "Northwind/billing-app" });
    expect(res.status).toBe(502);
    expect((await res.json()).error).toContain("alex/eng-1..bad");
    expect(calls.filter((c) => c.url.includes("api.github.com"))).toEqual([]);
  });
});
