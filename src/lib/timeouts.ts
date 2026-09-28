/**
 * The request budgets the browser and the routes have to agree on.
 *
 * They live together because they are one constraint, not two: whatever the
 * server can spend on an upstream call has to finish inside the browser's own
 * abort, or the panel replaces the upstream error with a bare `TimeoutError`
 * and the reason it failed is gone. Keeping them in separate files let that
 * gap close to 1.5s unnoticed, so `assertServerFitsClient` is checked by a test
 * rather than left as a comment.
 */

/**
 * How long the dashboard's fetcher waits before aborting a panel request.
 *
 * SWR schedules the next poll only after the promise settles, so a request that
 * never resolves - severed mid-flight by system sleep, say - kills auto-refresh
 * permanently. This is what stops that.
 */
export const CLIENT_FETCH_TIMEOUT_MS = 30_000;

/**
 * What the client's budget has to cover besides the upstream call itself:
 * reading config off disk, reshaping, JSON serialisation, Next's own overhead,
 * and the browser actually receiving the response.
 */
export const SERVER_OVERHEAD_ALLOWANCE_MS = 5_000;

/** The most an upstream call may spend and still leave room for the above. */
export function upstreamBudgetMs(): number {
  return CLIENT_FETCH_TIMEOUT_MS - SERVER_OVERHEAD_ALLOWANCE_MS;
}

/**
 * Whether an upstream call's worst case fits inside the client's abort.
 *
 * "Worst case" is the whole retry sequence, not one attempt: a failure slow
 * enough to be worth retrying, plus the delay, plus a second attempt that hangs
 * to its own timeout.
 */
export function serverWorstCaseFitsClient(worstCaseMs: number): boolean {
  return worstCaseMs <= upstreamBudgetMs();
}

/** How long a subprocess may run before `runCommand` kills it. */
export const COMMAND_TIMEOUT_MS = 10_000;

/**
 * How long `git worktree remove` may run.
 *
 * Not the ordinary command timeout: a worktree holding `node_modules` takes well
 * over 10s to delete, and killing git partway through leaves a half-deleted
 * directory with its admin record still in place.
 */
export const WORKTREE_REMOVE_TIMEOUT_MS = 120_000;

/** How long ending a session waits for its processes to let go of their ttys. */
export const KILL_DRAIN_TIMEOUT_MS = 4_000;

/**
 * The most POST /api/terminal/kill can take: every step at its own timeout, in
 * order. Listing the session's ttys, killing it, draining (one `ps` may still be
 * running when the drain deadline passes), listing worktrees, checking the
 * worktree is clean, removing it and pruning.
 */
export const KILL_ROUTE_WORST_CASE_MS =
  COMMAND_TIMEOUT_MS * 2 +
  KILL_DRAIN_TIMEOUT_MS +
  COMMAND_TIMEOUT_MS +
  COMMAND_TIMEOUT_MS * 2 +
  WORKTREE_REMOVE_TIMEOUT_MS +
  COMMAND_TIMEOUT_MS;

/**
 * How long the browser waits for that route. Derived rather than chosen: when
 * this was a fixed 10s the client gave up on every removal of a real worktree
 * and said the dashboard was unreachable while git was still deleting.
 */
export const KILL_CLIENT_TIMEOUT_MS = KILL_ROUTE_WORST_CASE_MS + SERVER_OVERHEAD_ALLOWANCE_MS;
