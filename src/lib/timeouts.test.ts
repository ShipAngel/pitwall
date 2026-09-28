import { describe, expect, it } from "vitest";
import {
  CLIENT_FETCH_TIMEOUT_MS,
  COMMAND_TIMEOUT_MS,
  KILL_CLIENT_TIMEOUT_MS,
  KILL_ROUTE_WORST_CASE_MS,
  WORKTREE_REMOVE_TIMEOUT_MS,
  SERVER_OVERHEAD_ALLOWANCE_MS,
  serverWorstCaseFitsClient,
  upstreamBudgetMs,
} from "./timeouts";

describe("upstreamBudgetMs", () => {
  it("leaves the overhead allowance out of the client's budget", () => {
    expect(upstreamBudgetMs()).toBe(
      CLIENT_FETCH_TIMEOUT_MS - SERVER_OVERHEAD_ALLOWANCE_MS,
    );
  });

  it("keeps a real allowance rather than spending the whole budget", () => {
    // Not derived from the constants: an allowance whittled to nothing is the
    // failure this module exists to stop, and an assertion computed from the
    // same numbers would move along with it.
    expect(upstreamBudgetMs()).toBeLessThan(CLIENT_FETCH_TIMEOUT_MS);
    expect(SERVER_OVERHEAD_ALLOWANCE_MS).toBeGreaterThanOrEqual(2_000);
  });
});

describe("serverWorstCaseFitsClient", () => {
  it("accepts a worst case inside the budget", () => {
    expect(serverWorstCaseFitsClient(upstreamBudgetMs() - 1)).toBe(true);
  });

  it("accepts a worst case exactly at the budget", () => {
    expect(serverWorstCaseFitsClient(upstreamBudgetMs())).toBe(true);
  });

  it("rejects a worst case past the budget", () => {
    expect(serverWorstCaseFitsClient(upstreamBudgetMs() + 1)).toBe(false);
  });

  it("rejects the 28.5s sequence this was written for", () => {
    // 8s retry ceiling + 0.5s delay + a 20s second attempt, against the
    // client's 30s abort: 1.5s left for config reading, serialisation and
    // Next's overhead. When it didn't fit, the panel replaced the GitHub error
    // with a bare TimeoutError.
    expect(serverWorstCaseFitsClient(28_500)).toBe(false);
  });
});

describe("the kill route's budget", () => {
  it("lets the browser wait longer than the route can take", () => {
    // When the client aborted at a fixed 10s, removing any real worktree timed
    // out in the browser while git was still deleting on the server.
    expect(KILL_CLIENT_TIMEOUT_MS).toBeGreaterThan(KILL_ROUTE_WORST_CASE_MS);
  });

  it("counts the worktree removal at its own timeout, not the ordinary one", () => {
    expect(KILL_ROUTE_WORST_CASE_MS).toBeGreaterThan(WORKTREE_REMOVE_TIMEOUT_MS);
    expect(WORKTREE_REMOVE_TIMEOUT_MS).toBeGreaterThan(COMMAND_TIMEOUT_MS);
  });
});
