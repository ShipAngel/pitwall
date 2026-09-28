import { NextResponse } from "next/server";
import { readConfig } from "@/lib/config";
import {
  fetchLinearGraphQL,
  fetchLiveCyclePoints,
  fetchStartedStateFlow,
  fetchMyCycleIssues,
  isCurrentCycle,
  LINEAR_TEAM_CYCLES_QUERY,
  LINEAR_TEAM_STATES_QUERY,
  LINEAR_VIEWER_QUERY,
  parseTicketPR,
  type RawLinearTeamCyclesResponse,
  type RawLinearTeamStatesResponse,
  type RawLinearViewerResponse,
} from "@/lib/linear";
import {
  buildCyclePoints,
  isActiveAt,
  RECENT_CYCLE_COUNT,
  recentCycleNumbers,
} from "@/lib/cycles";
import type { CyclePoints, LinearResponse, LinearTicket, TicketPR } from "@/types";

export const dynamic = "force-dynamic";

/** Enough for 500 open tickets, and a bound on a runaway cursor. */
const MAX_VIEWER_PAGES = 5;

/**
 * The viewer, with every open ticket assigned to them rather than the first
 * page of 100. Lives here rather than in lib/linear so the route tests, which
 * stub `fetchLinearGraphQL`, drive every page.
 */
async function fetchViewerWithAllIssues(apiKey: string): Promise<RawLinearViewerResponse> {
  const first = await fetchLinearGraphQL<RawLinearViewerResponse>(apiKey, LINEAR_VIEWER_QUERY, {
    after: null,
  });
  const nodes = [...first.viewer.assignedIssues.nodes];
  let pageInfo = first.viewer.assignedIssues.pageInfo;
  for (let page = 1; page < MAX_VIEWER_PAGES && pageInfo?.hasNextPage; page++) {
    const next = await fetchLinearGraphQL<RawLinearViewerResponse>(apiKey, LINEAR_VIEWER_QUERY, {
      after: pageInfo.endCursor,
    });
    nodes.push(...next.viewer.assignedIssues.nodes);
    pageInfo = next.viewer.assignedIssues.pageInfo;
  }
  return { ...first, viewer: { ...first.viewer, assignedIssues: { nodes } } };
}

export async function GET() {
  try {
    const apiKey = process.env.LINEAR_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "LINEAR_API_KEY is not set in .env.local" },
        { status: 500 },
      );
    }

    const config = await readConfig();

    const [viewerData, statesData, cyclesData] = await Promise.all([
      fetchViewerWithAllIssues(apiKey),
      fetchLinearGraphQL<RawLinearTeamStatesResponse>(apiKey, LINEAR_TEAM_STATES_QUERY, {
        teamKey: config.linear.teamKey,
      }),
      fetchLinearGraphQL<RawLinearTeamCyclesResponse>(apiKey, LINEAR_TEAM_CYCLES_QUERY, {
        teamKey: config.linear.teamKey,
      }),
    ]);

    // A second round trip, because which statuses to count is itself an answer
    // from Linear — the flow can't be asked for until the states are known. Kept
    // as a promise rather than awaited here: the cycle-points work below depends
    // only on `cyclesData`, so awaiting now would serialise two independent
    // request sets and make every refresh the sum of both.
    // A team key Linear doesn't know returns no team at all, which used to
    // render as a team with no work: empty Flow, empty Cycle Points, no error.
    if (statesData.teams.nodes.length === 0) {
      return NextResponse.json(
        {
          error:
            `Linear has no team with key '${config.linear.teamKey}' that this API key ` +
            `can see. Check linear.teamKey in config.json.`,
        },
        { status: 400 },
      );
    }

    const team = statesData.teams.nodes[0];
    const allStates = team?.states.nodes ?? [];
    const statusFlowPromise = fetchStartedStateFlow(
      apiKey,
      config.linear.teamKey,
      allStates,
    );
    // Awaited further down, after the cycle work. If that work throws first,
    // this promise's own rejection would otherwise go unhandled.
    statusFlowPromise.catch(() => {});

    // The most recent RECENT_CYCLE_COUNT cycles, with team scope and the viewer's
    // own points. Counting back from the one in progress, so the set moves with
    // the calendar rather than being pinned to numbers.
    const nowMs = Date.now();
    const rawCycles = cyclesData.teams.nodes[0]?.cycles.nodes ?? [];
    const cycleNumbers = recentCycleNumbers(rawCycles, nowMs, RECENT_CYCLE_COUNT);
    let cyclePoints: CyclePoints[] = [];
    if (cycleNumbers.length > 0) {
      // The in-progress cycle's snapshot history lags by up to a day, so sum its
      // points live. Finished cycles keep their snapshots — see buildCyclePoints.
      const activeCycle = rawCycles.find(
        (c) => cycleNumbers.includes(c.number) && isActiveAt(c, nowMs),
      );
      const [myCycleIssues, liveActive] = await Promise.all([
        fetchMyCycleIssues(apiKey, config.linear.teamKey, cycleNumbers),
        activeCycle
          ? fetchLiveCyclePoints(apiKey, config.linear.teamKey, activeCycle.number)
          : Promise.resolve(null),
      ]);
      const liveTeamPoints =
        activeCycle && liveActive
          ? new Map([[activeCycle.number, liveActive]])
          : undefined;
      cyclePoints = buildCyclePoints(
        rawCycles,
        cycleNumbers,
        myCycleIssues,
        nowMs,
        liveTeamPoints,
      );
    }

    const myTickets: LinearTicket[] = viewerData.viewer.assignedIssues.nodes.map(
      (n) => ({
        identifier: n.identifier,
        title: n.title,
        url: n.url,
        statusName: n.state.name,
        statusType: n.state.type,
        statusColor: n.state.color,
        statusPosition: n.state.position,
        cycleNumber: n.cycle?.number ?? null,
        isCurrentCycle: isCurrentCycle(n.cycle),
        teamKey: n.team.key,
        // Linear attaches Slack threads and Claude artifacts to issues too, so
        // parseTicketPR keeps only real GitHub PRs — and reads the state Linear
        // already tracks, so no second call to GitHub is needed.
        prs: (n.attachments?.nodes ?? [])
          .map(parseTicketPR)
          .filter((p): p is TicketPR => p !== null),
        parent: n.parent ?? null,
        childCount: n.children?.nodes.length ?? 0,
      }),
    );

    const availableStatusNames = allStates.map((s) => s.name).sort();
    const statusFlow = await statusFlowPromise;

    const response: LinearResponse = {
      viewer: {
        id: viewerData.viewer.id,
        name: viewerData.viewer.name,
        email: viewerData.viewer.email,
      },
      myTickets,
      statusFlow,
      teamKey: config.linear.teamKey,
      orgUrlKey: viewerData.organization.urlKey,
      availableStatusNames,
      cyclePoints,
      // Undefined only in fixtures that predate the fields; default to showing
      // everything, which is what every team saw before.
      cyclesEnabled: team?.cyclesEnabled ?? true,
      estimatesEnabled: (team?.issueEstimationType ?? "") !== "notUsed",
      teamKeys: (viewerData.teams?.nodes ?? []).map((t) => t.key),
    };
    return NextResponse.json(response);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
