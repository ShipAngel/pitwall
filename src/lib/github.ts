import type { CheckSuiteConclusions, RepoConfig, RollupContextCounts } from "@/types";

const GITHUB_GRAPHQL = "https://api.github.com/graphql";

/** Default PR label treated as work-in-progress. GitHub matches label names case-insensitively. */
export const DEFAULT_WIP_LABEL = "wip";

/**
 * Nodes fetched per search. Neither search paginates: one page is far more PRs
 * than one person has open or owes a review on. The review-requests search asks
 * for `totalCount` alongside so a queue longer than this is admitted to rather
 * than silently truncated.
 */
export const SEARCH_PAGE_SIZE = 50;

/**
 * HTTP statuses worth a second attempt.
 *
 * A GitHub GraphQL query killed for taking too long comes back as nginx's 502
 * with an HTML body, not as a GraphQL error - the same thing GitHub's genuinely
 * transient 502s look like. `RETRY_ONLY_UNDER_MS` is what separates them.
 */
const RETRYABLE_STATUSES = new Set([502, 503, 504]);

const RETRY_DELAY_MS = 500;

/**
 * A failure slower than this is not retried.
 *
 * GitHub kills a query at ~10s, and that 502 arrives as a 502 like any other. A
 * retry of one cannot succeed - the query is too heavy, and it will be just as
 * heavy half a second later, so retrying only doubles how long the panel takes
 * to admit it is broken. Every query here is ~2-3s, so anything answering this
 * slowly is the ceiling rather than a blip.
 */
const RETRY_ONLY_UNDER_MS = 8_000;

/**
 * Per attempt, not per call.
 *
 * Sized against the browser's own abort rather than picked: see
 * WORST_CASE_REQUEST_MS. At 20s the sequence came to 28.5s against the client's
 * 30s and left 1.5s for everything else, and when that didn't fit the panel
 * showed a bare TimeoutError instead of the GitHub error worth reading.
 */
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * The longest one call can take before it reports a failure.
 *
 * The whole retry sequence, not one attempt: a failure slow enough to still be
 * worth retrying, the delay, then a second attempt that hangs to its timeout.
 * `github.test.ts` checks this against `serverWorstCaseFitsClient`, so the two
 * budgets can't drift apart in separate files again.
 */
export const WORST_CASE_REQUEST_MS =
  RETRY_ONLY_UNDER_MS + RETRY_DELAY_MS + REQUEST_TIMEOUT_MS;

/** Attempts per query: the first, plus one retry on a fast transient failure. */
const MAX_ATTEMPTS = 2;

export async function fetchGitHubGraphQL<T>(
  token: string,
  query: string,
): Promise<T> {
  let lastError: Error = new Error("GitHub GraphQL: no attempt made");

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    if (attempt > 1) {
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }

    const startedAt = Date.now();
    let res: Response;
    try {
      res = await fetch(GITHUB_GRAPHQL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "User-Agent": "dev-dashboard",
        },
        body: JSON.stringify({ query }),
        cache: "no-store",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      // A rejection here is the connection failing rather than GitHub
      // answering: a keep-alive socket the other side has closed, ECONNRESET,
      // DNS not yet back after a resume from sleep. Retrying that is the whole
      // point, and this half used to escape the loop untouched - which mattered
      // more once the panel became several concurrent requests, since a stale
      // socket now has six chances a refresh to land on one instead of one.
      //
      // Our own AbortSignal firing lands here too, and needs no special case:
      // it can only fire after REQUEST_TIMEOUT_MS, which is past
      // RETRY_ONLY_UNDER_MS, so the guard below refuses it like any other slow
      // failure. Every caller is read-only, so re-POSTing is safe.
      const elapsedMs = Date.now() - startedAt;
      lastError = err instanceof Error ? err : new Error(String(err));
      if (elapsedMs >= RETRY_ONLY_UNDER_MS) throw lastError;
      if (attempt < MAX_ATTEMPTS) {
        console.warn(
          `GitHub API request failed after ${elapsedMs}ms (${lastError.message}), retrying once`,
        );
      }
      continue;
    }
    const elapsedMs = Date.now() - startedAt;

    if (!res.ok) {
      const body = await res.text();
      lastError = new Error(`GitHub API ${res.status}: ${body.slice(0, 500)}`);
      // A bad token or a rejected field won't come good on a second try.
      if (!RETRYABLE_STATUSES.has(res.status)) throw lastError;
      // Nor will a query GitHub killed for being too slow - see
      // RETRY_ONLY_UNDER_MS.
      if (elapsedMs >= RETRY_ONLY_UNDER_MS) throw lastError;
      if (attempt < MAX_ATTEMPTS) {
        // Logged because a silent retry is invisible: the dev server would show
        // a request half a second slower and nothing about GitHub being flaky.
        console.warn(
          `GitHub API ${res.status} after ${elapsedMs}ms, retrying once`,
        );
      }
      continue;
    }

    const json = (await res.json()) as { data?: T; errors?: unknown };
    if (json.errors && !(json.data && onlyNotFound(json.errors))) {
      throw new Error(`GitHub GraphQL errors: ${JSON.stringify(json.errors)}`);
    }
    if (!json.data) {
      throw new Error("GitHub GraphQL: empty response");
    }
    return json.data;
  }

  throw lastError;
}

/**
 * Whether every GraphQL error is a NOT_FOUND - a `repository(...)` block for a
 * repo that is misspelled in `config.json`, or that the token can't see.
 *
 * GitHub still answers the rest of the query, with that block as `null`. Throwing
 * on it took the whole GitHub panel down over one bad line of config, so those
 * errors are tolerated and the repo is reported as unavailable instead. Any other
 * error still fails the request: a bad field is our bug, not the user's config.
 */
export function onlyNotFound(errors: unknown): boolean {
  return (
    Array.isArray(errors) &&
    errors.length > 0 &&
    errors.every(
      (e) => typeof e === "object" && e !== null && (e as { type?: unknown }).type === "NOT_FOUND",
    )
  );
}

/**
 * Configured repos GitHub answered `null` for: misspelled, or not visible to the
 * token. A repo that exists always comes back as an object; only a failed
 * lookup comes back as `null`.
 */
export function unavailableRepos(
  data: RawGitHubResponse,
  repos: { owner: string; name: string }[],
): string[] {
  return repos
    .filter((r) => (data as Record<string, unknown>)[repoAlias(r.owner, r.name)] === null)
    .map((r) => `${r.owner}/${r.name}`);
}

export function repoAlias(owner: string, name: string): string {
  return `repo_${owner}_${name}`.replace(/[^a-zA-Z0-9_]/g, "_");
}

/**
 * Alias for a repo's approved-PR count.
 *
 * Separate from `repoAlias` because this one can't live inside the repository
 * block: `search` is a field on Query and nowhere else, and asking for it on
 * `Repository` is a hard GraphQL error that fails the whole query - which takes
 * the entire GitHub panel down, not just this column. Verified against the live
 * API, not assumed.
 */
export function approvedAlias(owner: string, name: string): string {
  return `approved_${repoAlias(owner, name)}`;
}

/**
 * Search qualifiers restricting a search to the configured repos.
 *
 * Repeating `repo:` ORs the qualifiers, so this is "any of these repos". Both PR
 * searches need it: unscoped, they are your whole GitHub account, and personal
 * work outside the org shows up in a dashboard that is meant to be about this
 * team's repos.
 *
 * One `repo:` per configured repo rather than one `org:` per owner, so the
 * panels contain exactly what `config.json` lists. The REST search API's
 * 256-character query cap does not apply here — GraphQL search accepts these
 * happily (verified live at 17 repos, ~550 characters).
 *
 * Empty when no repos are configured, which would leave the search wide open —
 * `configuredRepoFilter` is what makes that case safe.
 */
export function repoScopeQualifiers(repos: RepoConfig[]): string {
  return repos.map((r) => `repo:${r.owner}/${r.name}`).join(" ");
}

/**
 * Predicate for "this PR is in a configured repo", matching GitHub's own
 * case-insensitive treatment of owner and repo names.
 *
 * The searches are already scoped by `repoScopeQualifiers`, so this is the
 * second half of a belt-and-braces pair: it is what stops an empty `repos` list
 * — which produces an empty, and therefore unscoped, qualifier string — from
 * showing every PR you have anywhere.
 */
export function configuredRepoFilter(
  repos: RepoConfig[],
): (nameWithOwner: string) => boolean {
  const configured = new Set(
    repos.map((r) => `${r.owner}/${r.name}`.toLowerCase()),
  );
  return (nameWithOwner) => configured.has(nameWithOwner.toLowerCase());
}

/**
 * Per-repo approved searches per HTTP request.
 *
 * GitHub resolves a query's top-level aliases *serially* and kills anything
 * still running at ~10 seconds, answering with nginx's own 502 and an HTML body
 * - not a GraphQL error, so the failure carries no hint of why. Everything this
 * panel needs in one query measured 12.6s and 502'd on every single refresh;
 * these searches were 6.3s of that on their own, at ~350ms each. Six per
 * request keeps each one near 2s, and the requests run concurrently.
 */
export const APPROVED_SEARCHES_PER_QUERY = 6;

/**
 * The dashboard's GitHub reads, as separate queries deliberately.
 *
 * Splitting is what keeps each one clear of the 10s ceiling above; it is not a
 * micro-optimisation, and merging any two back together walks straight into a
 * panel that 502s. `fetchGitHubData` runs them in parallel and merges the
 * results back into one `RawGitHubResponse`, so nothing downstream knows.
 */
export type GitHubQuerySet = {
  /**
   * `viewer` plus the per-repo open and WIP counts. `viewer` lives here so this
   * query is never empty - `query { }` is a syntax error, and the repo blocks
   * are absent with nothing configured.
   *
   * Not chunked, unlike `approved`, because a repository block is ~60ms against
   * a search's ~350ms: 18 repos is 1.1s. It is the same failure mode further
   * away, so a `config.json` that grew several times over is where to look
   * first if this one starts 502ing.
   */
  counts: string;
  myPRs: string;
  reviewRequests: string;
  /** One query per chunk of repos; empty when no repos are configured. */
  approved: string[];
};

/**
 * The field set both PR searches share.
 *
 * Sent with each of them rather than once, now that they are separate requests.
 */
const PR_CORE_FRAGMENT = `
    fragment prCore on PullRequest {
      number
      title
      url
      isDraft
      createdAt
      reviewDecision
      headRefName
      # A fork's branch isn't on origin, and a fork PR whose head is "main" would
      # otherwise be matched to your own main checkout.
      isCrossRepository
      commits(last: 1) {
        nodes { commit {
          # Which run each verdict belongs to. The counts below are summed over
          # every suite on the commit, so a job that failed in a run a newer one
          # superseded is tallied like one failing now and the rollup stays red
          # with nothing left to fix. A suite's own conclusion separates them.
          # totalCount so a truncated page can be told from a clean one — see
          # liveSuites, which refuses a short list rather than reading it as
          # "nothing failed". workflowRun.workflow.id and createdAt are the
          # identity and ordering that let a re-run supersede the run it
          # replaced; without them a failure that was later re-run green would
          # read as live forever.
          # totalCount stays on this line on purpose: a github.test.ts guard
          # rejects a totalCount line on its own, since asking search for one is
          # the hard error that took the whole panel down. Here it is legitimate.
          checkSuites(first: 50) { totalCount
            nodes {
              conclusion
              status
              createdAt
              app { slug }
              workflowRun { workflow { id } }
            }
          }
          statusCheckRollup {
            state
            # Why the rollup is red, without paging every check: a cancelled run
            # rolls up identically to a failed one, and only these counts separate
            # them. first:1 because the nodes are unused — the counts are siblings
            # of the connection, not derived from the page.
            contexts(first: 1) {
              checkRunCountsByState { state count }
              statusContextCountsByState { state count }
            }
          }
        } }
      }
      repository { nameWithOwner }
      labels(first: 20) { nodes { name } }
    }
`;

/** Splits a list into runs of at most `size`. Never emits an empty chunk. */
function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

export function buildGitHubQueries(
  repos: RepoConfig[],
  wipLabel: string = DEFAULT_WIP_LABEL,
): GitHubQuerySet {
  // JSON.stringify safely quotes/escapes the (config-supplied) label for the query.
  const wipLabelLiteral = JSON.stringify(wipLabel);
  // Both searches carry the same repo scope, and both go through JSON.stringify
  // so config-supplied owner/repo names can't break out of the string literal.
  const scope = repoScopeQualifiers(repos);
  const scoped = (search: string) =>
    JSON.stringify(scope ? `${search} ${scope}` : search);
  const repoBlocks = repos
    .map(
      (r) => `
    ${repoAlias(r.owner, r.name)}: repository(owner: "${r.owner}", name: "${r.name}") {
      pullRequests(states: OPEN, first: 1) {
        totalCount
      }
      wip: pullRequests(states: OPEN, labels: [${wipLabelLiteral}], first: 1) {
        totalCount
      }
    }`,
    )
    .join("\n");

  // One search per repo rather than one search tallied by repository afterwards:
  // a search connection caps its node list at a page, so a tallied version would
  // silently undercount the moment a repo's approved PRs outgrew it. issueCount
  // is exact and costs one node. Each carries its own `repo:` qualifier, so
  // unlike the two scoped searches there is no empty-`repos` case to guard - no
  // repos means no blocks at all. A chunk of them costs 1 rate-limit point,
  // measured, because `first: 1` is what search is charged on.
  //
  // No `archived:false` here, deliberately, though both scoped searches carry
  // it: naming one repo makes the qualifier either a no-op or a silent zero, and
  // the silent zero is the dangerous half. `openCount` comes from the repository
  // block, which has no such filter, so an archived-but-still-configured repo
  // would keep its open PRs in the total while its approved count dropped to
  // nothing - inflating "to review" for exactly the repo nobody is working on.
  const approvedBlock = (r: RepoConfig) => {
    const q = JSON.stringify(
      `repo:${r.owner}/${r.name} is:pr is:open review:approved`,
    );
    return `
      ${approvedAlias(r.owner, r.name)}: search(query: ${q}, type: ISSUE, first: 1) {
        issueCount
      }`;
  };

  return {
    counts: `
    query {
      viewer { login }
      ${repoBlocks}
    }
  `,

    myPRs: `
    query {
      myOpenPRs: search(query: ${scoped("is:pr is:open author:@me archived:false")}, type: ISSUE, first: ${SEARCH_PAGE_SIZE}) {
        nodes {
          __typename
          ... on PullRequest {
            ...prCore
            # The state of GitHub's own merge button. mergeable is lazily
            # computed and can come back UNKNOWN on first read; it resolves on
            # the next refresh, so no retry here.
            mergeStateStatus
            # Merge-queue membership, which the field above cannot carry: its
            # enum has no queue member, so a queued PR reports CLEAN. (Named in
            # prose only here — a github.test.ts guard counts that field name.)
            isInMergeQueue
            mergeQueueEntry {
              state
              position
            }
          }
        }
      }
    }
${PR_CORE_FRAGMENT}`,

    // review-requested, not user-review-requested: the broad form includes
    // requests that arrive via a team you belong to, which is how most of
    // these land. The narrow one counts only direct personal requests and
    // would silently hide team review requests.
    reviewRequests: `
    query {
      reviewRequests: search(query: ${scoped("is:pr is:open review-requested:@me archived:false")}, type: ISSUE, first: ${SEARCH_PAGE_SIZE}) {
        # issueCount, not totalCount: a search connection has no totalCount, and
        # asking for one is a hard query error that takes the whole GitHub panel
        # down. PRs are issues to search, so this is the count of matching PRs.
        # Exact even when the node list is capped, so the panel can admit to
        # showing a subset rather than under-reporting the queue.
        issueCount
        nodes {
          __typename
          ... on PullRequest {
            ...prCore
            author { login }
            # How big the review job is — the first thing you triage on.
            additions
            deletions
          }
        }
      }
    }
${PR_CORE_FRAGMENT}`,

    approved: chunk(repos, APPROVED_SEARCHES_PER_QUERY).map(
      (group) => `
    query {
${group.map(approvedBlock).join("\n")}
    }
  `,
    ),
  };
}

/**
 * Runs the whole query set concurrently and merges it into one response.
 *
 * Merged by top-level alias, which is why each query's fields are uniquely
 * named - the shape the route sees is identical to the single query this
 * replaced. Any one failure fails the lot: a missing chunk would present a
 * repo's approved count as zero, which reads as "nothing to merge" rather than
 * as an error.
 */
export async function fetchGitHubData(
  token: string,
  queries: GitHubQuerySet,
): Promise<RawGitHubResponse> {
  const parts = await Promise.all(
    [
      queries.counts,
      queries.myPRs,
      queries.reviewRequests,
      ...queries.approved,
    ].map((q) => fetchGitHubGraphQL<Record<string, unknown>>(token, q)),
  );
  return Object.assign({}, ...parts) as RawGitHubResponse;
}

export type GitHubPRNode = {
  __typename?: string;
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  createdAt: string;
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  headRefName?: string;
  isCrossRepository?: boolean | null;
  mergeStateStatus?: string | null;
  /** Only ever asked for on your own PRs, alongside mergeStateStatus. */
  isInMergeQueue?: boolean | null;
  mergeQueueEntry?: { state?: string | null; position?: number | null } | null;
  commits?: {
    nodes: Array<{
      commit: {
        checkSuites?: CheckSuiteConclusions | null;
        statusCheckRollup?: {
          state?: string | null;
          contexts?: RollupContextCounts | null;
        } | null;
      };
    }>;
  };
  repository: { nameWithOwner: string };
  labels?: { nodes: Array<{ name: string }> };
  /** Absent on a deleted ("ghost") account. */
  author?: { login: string } | null;
  additions?: number;
  deletions?: number;
};

export type RawGitHubResponse = {
  viewer: { login: string };
  myOpenPRs: { nodes: GitHubPRNode[] };
  /** `issueCount` is search's total — the connection has no `totalCount`. */
  reviewRequests?: { issueCount?: number; nodes: GitHubPRNode[] };
  [alias: string]: unknown;
};

export function getRepoOpenCount(
  data: RawGitHubResponse,
  owner: string,
  name: string,
): number {
  const block = data[repoAlias(owner, name)] as
    | { pullRequests?: { totalCount?: number } }
    | undefined;
  return block?.pullRequests?.totalCount ?? 0;
}

export function getRepoWipCount(
  data: RawGitHubResponse,
  owner: string,
  name: string,
): number {
  const block = data[repoAlias(owner, name)] as
    | { wip?: { totalCount?: number } }
    | undefined;
  return block?.wip?.totalCount ?? 0;
}

/**
 * Open PRs in a repo carrying an approving review.
 *
 * `issueCount`, not `totalCount` - a search connection has no `totalCount`, and
 * asking for one is a hard query error rather than a missing field.
 */
export function getRepoApprovedCount(
  data: RawGitHubResponse,
  owner: string,
  name: string,
): number {
  const block = data[approvedAlias(owner, name)] as
    | { issueCount?: number }
    | undefined;
  return block?.issueCount ?? 0;
}
