import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig, CyclePoints } from "@/types";

/**
 * The wiring here is what the pure lib tests can't reach, and it's where the
 * stale-cycle-points bug actually lived: choosing the active cycle, fetching
 * live points for that one only, and falling back to snapshots when the live
 * sum is unavailable. Network functions are stubbed; the real query constants
 * and helpers are kept so the dispatch below matches genuine operation names.
 */

const config = (over: Partial<AppConfig> = {}): AppConfig => ({
  repos: [],
  linear: { teamKey: "ENG" },
  refreshIntervalSeconds: 300,
  ...over,
});

const readConfig = vi.hoisted(() => vi.fn());
vi.mock("@/lib/config", () => ({ readConfig }));

const fetchLinearGraphQL = vi.hoisted(() => vi.fn());
const fetchLiveCyclePoints = vi.hoisted(() => vi.fn());
const fetchMyCycleIssues = vi.hoisted(() => vi.fn());
// Stubbed like the other network helpers rather than driven through
// fetchLinearGraphQL: its calls to that live inside lib/linear's own module
// scope, so overriding the export here would not reach them.
const fetchStartedStateFlow = vi.hoisted(() => vi.fn());
vi.mock("@/lib/linear", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/linear")>()),
  fetchLinearGraphQL,
  fetchLiveCyclePoints,
  fetchMyCycleIssues,
  fetchStartedStateFlow,
}));

// Cycle windows relative to real time, so no fake timers are needed.
const DAY = 86_400_000;
const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY).toISOString();

/** 56 is in progress; 55 and 54 are closed. */
const CYCLES = [
  {
    number: 56,
    startsAt: iso(-2),
    endsAt: iso(5),
    scopeHistory: [200, 282],
    completedScopeHistory: [50, 108],
  },
  {
    number: 55,
    startsAt: iso(-9),
    endsAt: iso(-2),
    scopeHistory: [248],
    completedScopeHistory: [113],
  },
  {
    number: 54,
    startsAt: iso(-16),
    endsAt: iso(-9),
    scopeHistory: [256],
    completedScopeHistory: [129],
  },
];

/** A workflow state as Linear returns it; `type` is what selects the flow. */
type State = {
  id: string;
  name: string;
  type: string;
  color: string;
  position: number;
};

const state = (
  name: string,
  type: string,
  position: number,
  id = name.toLowerCase().replace(/\s+/g, "-"),
): State => ({ id, name, type, color: "#abc", position });

/** Two started states out of order, so `position` has something to sort. */
const STATES: State[] = [
  state("In Acceptance", "started", 3),
  state("In Review", "started", 2),
  state("Done", "completed", 9),
];

type Payloads = {
  viewerIssues?: unknown[];
  states?: State[];
  cycles?: typeof CYCLES;
};

/** Routes each call to the right payload by GraphQL operation name. */
function stubQueries(p: Payloads = {}) {
  fetchLinearGraphQL.mockImplementation(async (_key: string, query: string) => {
    if (query.includes("LinearViewer")) {
      return {
        organization: { urlKey: "northwind" },
        teams: { nodes: [{ key: "ENG" }, { key: "OPS" }] },
        viewer: {
          id: "u1",
          name: "Alex Doe",
          email: "alex@example.com",
          assignedIssues: { nodes: p.viewerIssues ?? [] },
        },
      };
    }
    if (query.includes("LinearTeamStates")) {
      return { teams: { nodes: [{ states: { nodes: p.states ?? STATES } }] } };
    }
    if (query.includes("LinearTeamCycles")) {
      return { teams: { nodes: [{ cycles: { nodes: p.cycles ?? CYCLES } }] } };
    }
    throw new Error(`unexpected query: ${query.slice(0, 40)}`);
  });
}

async function callGET() {
  const { GET } = await import("@/app/api/linear/route");
  return GET();
}

const byNumber = (body: { cyclePoints: CyclePoints[] }): Record<number, CyclePoints> =>
  Object.fromEntries(body.cyclePoints.map((c) => [c.number, c]));

beforeEach(() => {
  vi.resetModules();
  readConfig.mockResolvedValue(config());
  vi.stubEnv("LINEAR_API_KEY", "lin-test-key");
  fetchLiveCyclePoints.mockResolvedValue({ total: 321, completed: 120 });
  fetchMyCycleIssues.mockResolvedValue([]);
  fetchStartedStateFlow.mockResolvedValue([]);
  stubQueries();
});

afterEach(() => {
  vi.unstubAllEnvs();
  fetchLinearGraphQL.mockReset();
  fetchLiveCyclePoints.mockReset();
  fetchMyCycleIssues.mockReset();
  fetchStartedStateFlow.mockReset();
  readConfig.mockReset();
});

describe("GET /api/linear", () => {
  it("500s when the API key is missing, without querying Linear", async () => {
    vi.stubEnv("LINEAR_API_KEY", "");
    const res = await callGET();
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({
      error: "LINEAR_API_KEY is not set in .env.local",
    });
    expect(fetchLinearGraphQL).not.toHaveBeenCalled();
  });

  describe("live vs snapshot cycle points", () => {
    it("requests live points for the active cycle only, once", async () => {
      await callGET();
      expect(fetchLiveCyclePoints).toHaveBeenCalledTimes(1);
      expect(fetchLiveCyclePoints).toHaveBeenCalledWith("lin-test-key", "ENG", 56);
    });

    it("uses the live sum for the active cycle, not its stale snapshot", async () => {
      const body = byNumber(await (await callGET()).json());
      expect(body[56].teamCompleted).toBe(120); // live, not 108
      expect(body[56].teamTotal).toBe(321); // live, not 282
    });

    it("keeps snapshots for closed cycles", async () => {
      const body = byNumber(await (await callGET()).json());
      expect(body[55]).toMatchObject({ teamCompleted: 113, teamTotal: 248 });
      expect(body[54]).toMatchObject({ teamCompleted: 129, teamTotal: 256 });
    });

    it("falls back to the snapshot when the live sum is unavailable", async () => {
      fetchLiveCyclePoints.mockResolvedValue(null);
      const body = byNumber(await (await callGET()).json());
      expect(body[56].teamCompleted).toBe(108);
      expect(body[56].teamTotal).toBe(282);
    });

    it("skips the live request entirely when no cycle is in progress", async () => {
      const past = CYCLES.map((c, i) => ({
        ...c,
        startsAt: iso(-40 + i),
        endsAt: iso(-30 + i),
      }));
      stubQueries({ cycles: past });
      const body = await (await callGET()).json();
      expect(fetchLiveCyclePoints).not.toHaveBeenCalled();
      expect(body.cyclePoints.every((c: { isCurrent: boolean }) => !c.isCurrent)).toBe(true);
    });

    it("marks exactly one cycle as current", async () => {
      const body = await (await callGET()).json();
      expect(
        body.cyclePoints.filter((c: { isCurrent: boolean }) => c.isCurrent),
      ).toHaveLength(1);
    });

    it("returns no cycle points when the team has no cycles", async () => {
      stubQueries({ cycles: [] });
      const body = await (await callGET()).json();
      expect(body.cyclePoints).toEqual([]);
      expect(fetchLiveCyclePoints).not.toHaveBeenCalled();
    });

    it("returns the three most recent cycles, newest first", async () => {
      const body = await (await callGET()).json();
      expect(body.cyclePoints.map((c: { number: number }) => c.number)).toEqual([56, 55, 54]);
    });
  });

  describe("in-flight status flow", () => {
    // Wiring, not arithmetic: which states count as in-flight and how they sort
    // is `startedStates`, tested in lib/linear.test.ts. What can only break here
    // is handing the helper the wrong team or the wrong states.
    it("asks for the flow with the configured team and the states just fetched", async () => {
      await callGET();
      expect(fetchStartedStateFlow).toHaveBeenCalledTimes(1);
      const [, teamKey, states] = fetchStartedStateFlow.mock.calls[0];
      expect(teamKey).toBe("ENG");
      expect(states).toEqual(STATES);
    });

    it("returns the flow it was given", async () => {
      const flow = [
        { id: "in-review", name: "In Review", color: "#abc", count: 3, points: 8, truncated: false },
      ];
      fetchStartedStateFlow.mockResolvedValue(flow);
      const body = await (await callGET()).json();
      expect(body.statusFlow).toEqual(flow);
    });

    it("returns every workspace team key", async () => {
      const body = await (await callGET()).json();
      expect(body.teamKeys).toEqual(["ENG", "OPS"]);
    });

    it("reports whether the team uses cycles and estimates", async () => {
      // Two of the live teams this was checked against use neither; the panels
      // hide their cycle and point UI on the strength of these two flags.
      fetchLinearGraphQL.mockImplementation(async (_k: string, query: string) => {
        if (query.includes("LinearTeamStates")) {
          return {
            teams: {
              nodes: [{ cyclesEnabled: false, issueEstimationType: "notUsed", states: { nodes: STATES } }],
            },
          };
        }
        if (query.includes("LinearTeamCycles")) return { teams: { nodes: [{ cycles: { nodes: [] } }] } };
        return {
          organization: { urlKey: "northwind" },
          viewer: { id: "u1", name: "Alex Doe", email: "e", assignedIssues: { nodes: [] } },
        };
      });
      const body = await (await callGET()).json();
      expect(body.cyclesEnabled).toBe(false);
      expect(body.estimatesEnabled).toBe(false);
    });

    it("treats a team that estimates on any scale as using estimates", async () => {
      fetchLinearGraphQL.mockImplementation(async (_k: string, query: string) => {
        if (query.includes("LinearTeamStates")) {
          return {
            teams: { nodes: [{ cyclesEnabled: true, issueEstimationType: "tShirt", states: { nodes: STATES } }] },
          };
        }
        if (query.includes("LinearTeamCycles")) return { teams: { nodes: [{ cycles: { nodes: CYCLES } }] } };
        return {
          organization: { urlKey: "northwind" },
          viewer: { id: "u1", name: "Alex Doe", email: "e", assignedIssues: { nodes: [] } },
        };
      });
      const body = await (await callGET()).json();
      expect(body.cyclesEnabled).toBe(true);
      expect(body.estimatesEnabled).toBe(true);
    });

    it("says the team key is wrong rather than showing an empty team", async () => {
      fetchLinearGraphQL.mockImplementation(async (_k: string, query: string) => {
        if (query.includes("LinearTeamStates")) return { teams: { nodes: [] } };
        if (query.includes("LinearTeamCycles")) return { teams: { nodes: [] } };
        return {
          organization: { urlKey: "northwind" },
          viewer: { id: "u1", name: "K", email: "e", assignedIssues: { nodes: [] } },
        };
      });
      // This used to render Flow and Cycle Points as a team with no work.
      const res = await callGET();
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/no team with key 'ENG'.*linear\.teamKey/);
      expect(fetchStartedStateFlow).not.toHaveBeenCalled();
    });

    it("follows every page of the viewer's assigned tickets", async () => {
      const issue = (identifier: string) => ({
        identifier,
        title: identifier,
        url: `https://linear.app/x/${identifier}`,
        state: { name: "Todo", type: "unstarted", color: "#abc", position: 1 },
        cycle: null,
        team: { key: "ENG" },
        parent: null,
        children: { nodes: [] },
        attachments: { nodes: [] },
      });
      const afters: unknown[] = [];
      fetchLinearGraphQL.mockImplementation(
        async (_k: string, query: string, vars?: { after?: string | null }) => {
          if (query.includes("LinearTeamStates")) return { teams: { nodes: [{ states: { nodes: STATES } }] } };
          if (query.includes("LinearTeamCycles")) return { teams: { nodes: [{ cycles: { nodes: CYCLES } }] } };
          afters.push(vars?.after ?? null);
          const second = vars?.after === "c1";
          return {
            organization: { urlKey: "northwind" },
            viewer: {
              id: "u1",
              name: "Alex Doe",
              email: "alex@example.com",
              assignedIssues: {
                pageInfo: { hasNextPage: !second, endCursor: second ? null : "c1" },
                nodes: second ? [issue("ENG-2")] : [issue("ENG-1")],
              },
            },
          };
        },
      );
      const body = await (await callGET()).json();
      expect(afters).toEqual([null, "c1"]);
      expect(body.myTickets.map((t: { identifier: string }) => t.identifier)).toEqual([
        "ENG-1",
        "ENG-2",
      ]);
    });

    it("still lists every status name, not just the started ones", async () => {
      // The names are a diagnostic aid, so they stay complete even though the
      // flow deliberately isn't.
      const body = await (await callGET()).json();
      expect(body.availableStatusNames).toEqual(["Done", "In Acceptance", "In Review"]);
    });
  });

  it("maps the viewer's tickets and flags those in the active cycle", async () => {
    stubQueries({
      viewerIssues: [
        {
          identifier: "ENG-1",
          title: "current",
          url: "u1",
          state: { name: "In Progress", type: "started", color: "#fff", position: 1 },
          cycle: { number: 56, startsAt: iso(-2), endsAt: iso(5) },
          team: { key: "ENG" },
        },
        {
          identifier: "ENG-2",
          title: "older",
          url: "u2",
          state: { name: "In Review", type: "started", color: "#eee", position: 2 },
          cycle: { number: 55, startsAt: iso(-9), endsAt: iso(-2) },
          team: { key: "ENG" },
        },
        {
          identifier: "ENG-3",
          title: "no cycle",
          url: "u3",
          state: { name: "Backlog", type: "unstarted", color: "#ddd", position: 0 },
          cycle: null,
          team: { key: "ENG" },
        },
      ],
    });
    const body = await (await callGET()).json();
    expect(
      body.myTickets.map((t: { identifier: string; isCurrentCycle: boolean; cycleNumber: number | null }) => [
        t.identifier,
        t.cycleNumber,
        t.isCurrentCycle,
      ]),
    ).toEqual([
      ["ENG-1", 56, true],
      ["ENG-2", 55, false],
      ["ENG-3", null, false],
    ]);
  });

  it("asks for the viewer's cycle issues via the paginating helper", async () => {
    await callGET();
    expect(fetchMyCycleIssues).toHaveBeenCalledWith("lin-test-key", "ENG", [56, 55, 54]);
  });

  it("sums the viewer's own points per cycle from that helper's result", async () => {
    fetchMyCycleIssues.mockResolvedValue([
      { estimate: 5, cycle: { number: 56 }, state: { type: "completed" } },
      { estimate: 3, cycle: { number: 56 }, state: { type: "started" } },
      { estimate: 8, cycle: { number: 55 }, state: { type: "completed" } },
    ]);
    const body = byNumber(await (await callGET()).json());
    expect(body[56]).toMatchObject({ myCompleted: 5, myTotal: 8 });
    expect(body[55]).toMatchObject({ myCompleted: 8, myTotal: 8 });
  });

  it("passes through the viewer and org identity", async () => {
    const body = await (await callGET()).json();
    expect(body.viewer).toEqual({ id: "u1", name: "Alex Doe", email: "alex@example.com" });
    expect(body.orgUrlKey).toBe("northwind");
    expect(body.teamKey).toBe("ENG");
  });

  it("never leaks the API key into the response", async () => {
    const res = await callGET();
    expect(JSON.stringify(await res.json())).not.toContain("lin-test-key");
  });

  it("500s when a Linear query fails", async () => {
    fetchLinearGraphQL.mockRejectedValue(new Error("Linear API 429: rate limited"));
    const res = await callGET();
    expect(res.status).toBe(500);
    expect((await res.json()).error).toContain("Linear API 429");
  });

  it("500s when config can't be read", async () => {
    readConfig.mockRejectedValue(new Error("config.json not found"));
    const res = await callGET();
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("config.json not found");
  });
});
