import { describe, expect, it } from "vitest";
import type { TerminalTarget } from "./terminal";
import { prepareWorktree, type WorktreeDeps } from "./worktreePrep";

/**
 * Every git call goes through a fake that records it in order and answers from
 * a small script, so each guard the sidecar depends on is asserted as a call
 * sequence rather than trusted to a comment.
 */

const REPO = "/Users/alexdoe/Dev/forms-app";
const TARGET: TerminalTarget = {
  sessionName: "pitwall_Acme-forms-app_7",
  repoPath: REPO,
  worktreePath: "/Users/alexdoe/.pitwall/worktrees/Acme-forms-app/pr-7-feature-x",
  branch: "feature/x",
  command: ["claude"],
};

function worktreeList(entries: Array<{ path: string; branch?: string }>): string {
  return entries
    .map((e) => [`worktree ${e.path}`, ...(e.branch ? [`branch refs/heads/${e.branch}`] : ["detached"]), ""].join("\n"))
    .join("\n");
}

function fakeDeps(opts: {
  list?: string;
  localRefs?: string[];
  remoteRefs?: string[];
  realpaths?: Record<string, string>;
  dirty?: boolean;
  failFetch?: boolean;
  failCheckout?: boolean;
} = {}) {
  const calls: string[] = [];
  const logs: string[] = [];
  const deps: WorktreeDeps = {
    async git(cwd, args) {
      calls.push(`${cwd}: ${args.join(" ")}`);
      if (args[0] === "worktree" && args[1] === "list") {
        return opts.list ?? worktreeList([{ path: REPO, branch: "main" }]);
      }
      if (args[0] === "status") return opts.dirty ? " M src/a.ts\n" : "";
      if (args[0] === "fetch" && opts.failFetch) throw new Error("offline");
      if (args[0] === "checkout" && opts.failCheckout) throw new Error("would be overwritten");
      return "";
    },
    async hasRef(_repo, ref) {
      if (ref.startsWith("refs/heads/")) {
        return (opts.localRefs ?? []).includes(ref.slice("refs/heads/".length));
      }
      return (opts.remoteRefs ?? []).includes(ref.slice("refs/remotes/origin/".length));
    },
    async realpath(p) {
      const real = opts.realpaths?.[p];
      if (real) return real;
      throw new Error("ENOENT");
    },
    log: (msg) => logs.push(msg),
  };
  return { deps, calls, logs };
}

const noop = () => {};

describe("prepareWorktree", () => {
  it("prunes stale records before it reads the list", async () => {
    // A deleted directory whose admin record survived would otherwise be read
    // as a worktree to reuse, and the checkout would run somewhere that isn't there.
    const { deps, calls } = fakeDeps({ localRefs: ["feature/x"] });
    await prepareWorktree(TARGET, noop, deps);
    expect(calls.slice(0, 2)).toEqual([
      `${REPO}: worktree prune`,
      `${REPO}: worktree list --porcelain`,
    ]);
  });

  it("reuses whatever already has the branch checked out, and adds nothing", async () => {
    const { deps, calls } = fakeDeps({
      list: worktreeList([
        { path: REPO, branch: "main" },
        { path: "/elsewhere/by-hand", branch: "feature/x" },
      ]),
    });
    await expect(prepareWorktree(TARGET, noop, deps)).resolves.toBe("/elsewhere/by-hand");
    expect(calls.some((c) => c.includes("worktree add"))).toBe(false);
  });

  it("adds a worktree for a local branch with no start point", async () => {
    const { deps, calls } = fakeDeps({ localRefs: ["feature/x"] });
    await expect(prepareWorktree(TARGET, noop, deps)).resolves.toBe(TARGET.worktreePath);
    expect(calls.at(-1)).toBe(`${REPO}: worktree add -- ${TARGET.worktreePath} feature/x`);
    expect(calls.some((c) => c.includes("fetch"))).toBe(false);
  });

  it("fetches and tracks origin/<branch> for a branch that exists only on the remote", async () => {
    const { deps, calls } = fakeDeps({ remoteRefs: ["feature/x"] });
    await prepareWorktree(TARGET, noop, deps);
    expect(calls).toContain(`${REPO}: fetch origin --quiet`);
    expect(calls.at(-1)).toBe(
      `${REPO}: worktree add --track -b feature/x -- ${TARGET.worktreePath} origin/feature/x`,
    );
  });

  it("carries on after a failed fetch when the remote ref is already known", async () => {
    const { deps, logs } = fakeDeps({ remoteRefs: ["feature/x"], failFetch: true });
    await expect(prepareWorktree(TARGET, noop, deps)).resolves.toBe(TARGET.worktreePath);
    expect(logs.join(" ")).toMatch(/fetch failed/);
  });

  it("refuses a branch that is neither local nor on origin", async () => {
    const { deps } = fakeDeps();
    await expect(prepareWorktree(TARGET, noop, deps)).rejects.toThrow(/not found locally or on origin/);
  });

  it("reuses a worktree sitting at the target path through a symlink, and switches it", async () => {
    // git reports worktree paths realpath'd; comparing the unresolved target
    // path would never match and the add would fail on an occupied path.
    const real = "/private/var/alexdoe/worktrees/pr-7-feature-x";
    const { deps, calls } = fakeDeps({
      localRefs: ["feature/x"],
      list: worktreeList([
        { path: REPO, branch: "main" },
        { path: real, branch: "feature/old" },
      ]),
      realpaths: { [TARGET.worktreePath]: real },
    });
    await expect(prepareWorktree(TARGET, noop, deps)).resolves.toBe(real);
    expect(calls).toContain(`${real}: checkout feature/x`);
    expect(calls.some((c) => c.includes("worktree add"))).toBe(false);
  });

  it("never switches a dirty worktree's branch, and opens it where it stands", async () => {
    const real = "/private/var/alexdoe/worktrees/pr-7-feature-x";
    const messages: string[] = [];
    const { deps, calls } = fakeDeps({
      localRefs: ["feature/x"],
      dirty: true,
      list: worktreeList([{ path: real, branch: "feature/old" }]),
      realpaths: { [TARGET.worktreePath]: real },
    });
    await expect(prepareWorktree(TARGET, (m) => messages.push(m), deps)).resolves.toBe(real);
    expect(calls.some((c) => c.includes("checkout"))).toBe(false);
    expect(messages.join(" ")).toMatch(/uncommitted changes/);
  });

  it("still opens the worktree when the switch fails, and says so", async () => {
    const real = "/private/var/alexdoe/worktrees/pr-7-feature-x";
    const messages: string[] = [];
    const { deps } = fakeDeps({
      localRefs: ["feature/x"],
      failCheckout: true,
      list: worktreeList([{ path: real, branch: "feature/old" }]),
      realpaths: { [TARGET.worktreePath]: real },
    });
    await expect(prepareWorktree(TARGET, (m) => messages.push(m), deps)).resolves.toBe(real);
    expect(messages.join(" ")).toMatch(/Could not switch it to feature\/x/);
  });
});
