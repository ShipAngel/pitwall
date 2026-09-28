import { parsePRRef } from "./view";
import type { StatusFlow, TicketPR, TicketPRStatus } from "@/types";

const LINEAR_GRAPHQL = "https://api.linear.app/graphql";

export async function fetchLinearGraphQL<T>(
  apiKey: string,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(LINEAR_GRAPHQL, {
    method: "POST",
    headers: {
      Authorization: apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Linear API ${res.status}: ${body.slice(0, 500)}`);
  }

  const json = (await res.json()) as { data?: T; errors?: unknown };
  if (json.errors) {
    throw new Error(`Linear GraphQL errors: ${JSON.stringify(json.errors)}`);
  }
  if (!json.data) {
    throw new Error("Linear GraphQL: empty response");
  }
  return json.data;
}

export const LINEAR_VIEWER_QUERY = `
  query LinearViewer($after: String) {
    organization { urlKey }
    # Every team key in the workspace, so a branch or title naming another
    # team's ticket (OPS-42) is recognised without trusting any capitals-dash-
    # digits string, which is how "HTTP-2" used to read as a ticket.
    teams(first: 250) { nodes { key } }
    viewer {
      id
      name
      email
      assignedIssues(
        filter: { completedAt: { null: true }, canceledAt: { null: true } }
        first: 100
        after: $after
      ) {
        # Followed by the route: stopping at the first page silently dropped
        # every ticket past 100.
        pageInfo { hasNextPage endCursor }
        nodes {
          identifier
          title
          url
          state { name type color position }
          cycle { number startsAt endsAt }
          team { key }
          # Present even when the parent isn't assigned to the viewer, so a child
          # can still be grouped under a header it can name and link.
          parent { identifier title }
          # Counted client-side: IssueConnection has no totalCount. 100 is far
          # above any real sub-issue count, and a miss would only soften the
          # "N sub-issues" hint, not a total anyone relies on.
          children(first: 100) { nodes { identifier } }
          # Linear's GitHub integration writes one attachment per linked PR.
          # 50 is far above any real issue's attachment count; unlike the cycle
          # queries a missed page would only cost a badge, not a total.
          attachments(first: 50) { nodes { url sourceType metadata } }
        }
      }
    }
  }
`;

// `type` and `position` are what make the flow panel self-maintaining: Linear
// groups its own workflow states into categories, so asking for the category is
// what lets a status added in Linear appear here without a config change, in the
// order Linear itself shows it.
export const LINEAR_TEAM_STATES_QUERY = `
  query LinearTeamStates($teamKey: String!) {
    teams(filter: { key: { eq: $teamKey } }) {
      nodes {
        # Whether the team uses cycles and estimates at all. Teams that don't
        # would otherwise see an empty Cycle Points panel and zero points on
        # every Flow card.
        cyclesEnabled
        issueEstimationType
        states {
          nodes { id name type color position }
        }
      }
    }
  }
`;

// Team-wide cycle scope comes from Linear's history fields (last element = the
// latest daily snapshot), so we get accurate totals without paginating issues.
export const LINEAR_TEAM_CYCLES_QUERY = `
  query LinearTeamCycles($teamKey: String!) {
    teams(filter: { key: { eq: $teamKey } }) {
      nodes {
        cycles(first: 30) {
          nodes { number startsAt endsAt scopeHistory completedScopeHistory }
        }
      }
    }
  }
`;

// The viewer's own points per cycle — there is no per-user cycle aggregate, so
// we sum estimates on their assigned issues in the target cycles.
export const LINEAR_MY_CYCLE_POINTS_QUERY = `
  query LinearMyCyclePoints($teamKey: String!, $cycleNumbers: [Float!]!, $after: String) {
    viewer {
      assignedIssues(
        filter: {
          team: { key: { eq: $teamKey } }
          cycle: { number: { in: $cycleNumbers } }
        }
        first: 250
        after: $after
      ) {
        pageInfo { hasNextPage endCursor }
        nodes {
          estimate
          cycle { number }
          state { type }
        }
      }
    }
  }
`;

/**
 * Every issue assigned to the viewer in the given cycles, following pagination.
 *
 * 250 is Linear's maximum page size. This previously took only the first page
 * and ignored `hasNextPage`, so a viewer with more than 250 assigned issues
 * across the displayed cycles would have had their points silently undercount.
 * Unlike team scope there is no snapshot to fall back on, so on hitting the page
 * cap this returns what it has rather than nothing — 250 x MAX_CYCLE_PAGES is
 * far beyond any real personal workload.
 */
export async function fetchMyCycleIssues(
  apiKey: string,
  teamKey: string,
  cycleNumbers: number[],
): Promise<MyCycleIssueNode[]> {
  const nodes: MyCycleIssueNode[] = [];
  let after: string | null = null;
  for (let page = 0; page < MAX_CYCLE_PAGES; page++) {
    const data: RawLinearMyCyclePointsResponse =
      await fetchLinearGraphQL<RawLinearMyCyclePointsResponse>(
        apiKey,
        LINEAR_MY_CYCLE_POINTS_QUERY,
        { teamKey, cycleNumbers, after },
      );
    const conn = data.viewer.assignedIssues;
    nodes.push(...conn.nodes);
    if (!conn.pageInfo?.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  return nodes;
}

/**
 * Live point totals for one cycle, summed from current issue state.
 *
 * `scopeHistory` / `completedScopeHistory` are *daily snapshots*, so for the
 * cycle in progress they lag real time — Linear's own UI sums live issue state,
 * which is why its "done" figure runs ahead of the last snapshot. Past cycles
 * deliberately keep using the snapshots: Linear rolls unfinished issues into the
 * next cycle, so a live query on a finished cycle sees only what stayed behind
 * and badly understates the scope that cycle actually carried.
 *
 * 250 is Linear's maximum page size; callers follow `pageInfo`.
 */
export const LINEAR_CYCLE_POINTS_QUERY = `
  query LinearCyclePoints($filter: IssueFilter!, $after: String) {
    issues(filter: $filter, first: 250, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { estimate }
    }
  }
`;

export type RawCycleIssuePage = {
  issues: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: Array<{ estimate: number | null }>;
  };
};

export type LiveCyclePoints = { total: number; completed: number };

/**
 * How many issues match `filter`, and their points, following pagination.
 *
 * Separate from `sumEstimatesForFilter` because a flow column needs both halves
 * and truncation means something different here: a count short by an unknown
 * amount is a wrong number on screen, where a points total can fall back to a
 * snapshot. `truncated` says so rather than quietly reporting the partial — the
 * silent-undercount bug this codebase has hit twice came from ignoring
 * `hasNextPage`, and a per-status count is exactly where it would recur.
 */
export async function countAndSumForFilter(
  apiKey: string,
  filter: Record<string, unknown>,
): Promise<{ count: number; points: number; truncated: boolean }> {
  let after: string | null = null;
  let count = 0;
  let points = 0;
  for (let page = 0; page < MAX_CYCLE_PAGES; page++) {
    const data: RawCycleIssuePage = await fetchLinearGraphQL<RawCycleIssuePage>(
      apiKey,
      LINEAR_CYCLE_POINTS_QUERY,
      { filter, after },
    );
    for (const node of data.issues.nodes) {
      count += 1;
      points += node.estimate ?? 0;
    }
    if (!data.issues.pageInfo.hasNextPage) return { count, points, truncated: false };
    after = data.issues.pageInfo.endCursor;
  }
  return { count, points, truncated: true };
}

/**
 * Every workflow state Linear files under "started", with its live count and
 * points — the team's flow, without a single status name written down here.
 *
 * One request per state rather than one nested query: Linear's 10k complexity
 * ceiling truncates a batched issues connection silently, and six states at 250
 * issues each would sail past it. They run concurrently, so the cost is one
 * round trip either way.
 */
export async function fetchStartedStateFlow(
  apiKey: string,
  teamKey: string,
  states: readonly LinearWorkflowState[],
): Promise<StatusFlow[]> {
  const started = startedStates(states);
  return Promise.all(
    started.map(async (s) => {
      const { count, points, truncated } = await countAndSumForFilter(apiKey, {
        team: { key: { eq: teamKey } },
        state: { id: { eq: s.id } },
      });
      return { id: s.id, name: s.name, color: s.color, count, points, truncated };
    }),
  );
}

/**
 * The states Linear categorises as in-flight, in the order its own settings
 * screen lists them. `type` is Linear's category, not a name we chose, which is
 * the whole point: renaming "In Review" or adding "QA" needs no change
 * here. Sorted by `position` because a Map over states has no meaningful order
 * and the panel should read the way Linear reads.
 */
export function startedStates(
  states: readonly LinearWorkflowState[],
): LinearWorkflowState[] {
  return states
    .filter((s) => s.type === "started")
    .slice()
    .sort((a, b) => a.position - b.position);
}

/** Page cap per connection, so one enormous cycle can't stall a refresh. */
const MAX_CYCLE_PAGES = 6;

/**
 * Sums `estimate` over every issue matching `filter`, following pagination.
 * Returns null when the result would be incomplete (more pages than
 * MAX_CYCLE_PAGES) so the caller can fall back to the snapshot instead of
 * showing a silently truncated total.
 */
async function sumEstimatesForFilter(
  apiKey: string,
  filter: Record<string, unknown>,
): Promise<number | null> {
  const { points, truncated } = await countAndSumForFilter(apiKey, filter);
  return truncated ? null : points;
}

/**
 * Live total and completed points for one cycle. Returns null on any failure or
 * truncation, so the caller keeps the snapshot values — a number that lags by a
 * day beats one that's wrong by an unknown amount.
 */
export async function fetchLiveCyclePoints(
  apiKey: string,
  teamKey: string,
  cycleNumber: number,
): Promise<LiveCyclePoints | null> {
  const base = {
    team: { key: { eq: teamKey } },
    cycle: { number: { eq: cycleNumber } },
  };
  try {
    const [total, completed] = await Promise.all([
      sumEstimatesForFilter(apiKey, base),
      sumEstimatesForFilter(apiKey, {
        ...base,
        state: { type: { eq: "completed" } },
      }),
    ]);
    if (total == null || completed == null) return null;
    return { total, completed };
  } catch {
    return null;
  }
}

export type RawLinearViewerResponse = {
  organization: { urlKey: string };
  teams?: { nodes: Array<{ key: string }> };
  viewer: {
    id: string;
    name: string;
    email: string;
    assignedIssues: {
      pageInfo?: { hasNextPage: boolean; endCursor: string | null };
      nodes: Array<{
        identifier: string;
        title: string;
        url: string;
        state: { name: string; type: string; color: string; position: number };
        cycle: { number: number; startsAt: string; endsAt: string } | null;
        team: { key: string };
        parent?: { identifier: string; title: string } | null;
        children?: { nodes: Array<{ identifier: string }> };
        attachments?: {
          nodes: Array<{
            url: string;
            sourceType: string;
            metadata?: Record<string, unknown> | null;
          }>;
        };
      }>;
    };
  };
};

/** One of Linear's workflow states, as its settings screen shows them. */
export type LinearWorkflowState = {
  id: string;
  name: string;
  /** Linear's own category: backlog | unstarted | started | completed | canceled. */
  type: string;
  color: string;
  position: number;
};

export type RawLinearTeamStatesResponse = {
  teams: {
    nodes: Array<{
      cyclesEnabled?: boolean;
      /** "notUsed" when the team doesn't estimate; otherwise the scale's name. */
      issueEstimationType?: string;
      states: { nodes: LinearWorkflowState[] };
    }>;
  };
};

export type RawLinearTeamCyclesResponse = {
  teams: {
    nodes: Array<{
      cycles: {
        nodes: Array<{
          number: number;
          startsAt: string;
          endsAt: string;
          scopeHistory: number[] | null;
          completedScopeHistory: number[] | null;
        }>;
      };
    }>;
  };
};

export type MyCycleIssueNode = {
  estimate: number | null;
  cycle: { number: number } | null;
  state: { type: string };
};

export type RawLinearMyCyclePointsResponse = {
  viewer: {
    assignedIssues: {
      pageInfo?: { hasNextPage: boolean; endCursor: string | null };
      nodes: MyCycleIssueNode[];
    };
  };
};

export function isCurrentCycle(
  cycle: { startsAt: string; endsAt: string } | null,
  now: Date = new Date(),
): boolean {
  if (!cycle) return false;
  const start = new Date(cycle.startsAt).getTime();
  const end = new Date(cycle.endsAt).getTime();
  const nowMs = now.getTime();
  return nowMs >= start && nowMs <= end;
}

/**
 * A linked PR built from a Linear attachment. Linear's GitHub integration stores
 * the PR's live state on the attachment, so no second round trip to GitHub is
 * needed to tell a merged PR from one still awaiting review.
 *
 * Returns null for anything that isn't a GitHub PR — Linear also attaches Slack
 * threads and document links.
 */
export function parseTicketPR(attachment: {
  url: string;
  sourceType?: string;
  metadata?: Record<string, unknown> | null;
}): TicketPR | null {
  if (attachment.sourceType && attachment.sourceType !== "github") return null;
  const ref = parsePRRef(attachment.url);
  if (!ref) return null;
  const meta = attachment.metadata ?? {};
  const raw = typeof meta.status === "string" ? meta.status : "";
  // Anything Linear doesn't call open is finished; a closed-unmerged PR is
  // distinguished from a merged one because "closed" reads as abandoned.
  const status: TicketPRStatus =
    raw === "open" ? "open" : raw === "closed" ? "closed" : raw === "merged" ? "merged" : "open";
  return {
    url: ref.url,
    repo: ref.repo,
    number: ref.number,
    status,
    isDraft: meta.draft === true,
  };
}
