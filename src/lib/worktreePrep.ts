import {
  findWorktreeAtPath,
  findWorktreeForBranch,
  parseWorktreeList,
  worktreeAddArgv,
  worktreeCheckoutArgv,
  type TerminalTarget,
  type WorktreeEntry,
} from "./terminal";

/**
 * Preparing the git worktree a per-PR terminal opens in.
 *
 * This used to live in term-server/index.ts, outside the test runner, which is
 * why its guards (prune before list, realpath before compare, no checkout over
 * uncommitted work) were only ever verified by hand. The side effects come in
 * through `WorktreeDeps`, so the sidecar passes the real ones and the tests pass
 * fakes that record every git call in order.
 */
export type WorktreeDeps = {
  /** Runs `git -C cwd ...args`, resolving stdout. Rejects when git exits non-zero. */
  git: (cwd: string, args: string[]) => Promise<string>;
  /** Whether `ref` resolves in the repo. */
  hasRef: (repoPath: string, ref: string) => Promise<boolean>;
  /** `fs.realpath`: rejects for a path that doesn't exist. */
  realpath: (p: string) => Promise<string>;
  log: (msg: string) => void;
};

/**
 * `git checkout` only refuses to switch when the dirty file is also modified
 * by the branch being switched to — otherwise it succeeds and carries the
 * uncommitted changes onto the new branch. So dirtiness is checked ourselves
 * rather than trusting checkout to protect it. `-uno`: untracked build output
 * shouldn't block a switch.
 */
async function hasUncommittedChanges(deps: WorktreeDeps, repoPath: string): Promise<boolean> {
  const status = await deps.git(repoPath, ["status", "--porcelain", "-uno"]);
  return status.trim().length > 0;
}

/**
 * The worktree for a PR's branch, creating it if this is the first visit.
 *
 * Three ways it already exists, and all three are reused rather than added
 * again: the branch is checked out somewhere (git permits it in only one
 * worktree, so a second PR on the same branch — or a worktree you made by hand —
 * would fail the add), or a worktree is sitting exactly where this PR's goes, or
 * both at once.
 */
export async function prepareWorktree(
  target: TerminalTarget,
  notify: (msg: string) => void,
  deps: WorktreeDeps,
): Promise<string> {
  const { repoPath, branch } = target;

  // Clears records of worktrees whose directories have been deleted. Done before
  // the list, not after: a stale record both makes `worktree add` refuse the path
  // and would be read below as a directory worth reusing.
  await deps.git(repoPath, ["worktree", "prune"]);

  const entries = parseWorktreeList(
    await deps.git(repoPath, ["worktree", "list", "--porcelain"]),
  );

  const existing = findWorktreeForBranch(entries, branch);
  if (existing) return existing;

  const startPoint = await resolveStartPoint(target, notify, deps);
  const occupant = findWorktreeAtPath(entries, await canonical(deps, target.worktreePath));
  if (occupant) return reuseWorktree(target, occupant, startPoint, notify, deps);

  notify(`Creating worktree for ${branch}…`);
  await deps.git(
    repoPath,
    worktreeAddArgv({ worktreePath: target.worktreePath, branch, startPoint }),
  );
  return target.worktreePath;
}

/**
 * A path spelled the way `git worktree list` spells it — realpath'd, so a
 * symlinked component doesn't make the same directory compare unequal. Missing
 * paths come back unchanged: nothing can be occupying one.
 */
async function canonical(deps: WorktreeDeps, p: string): Promise<string> {
  try {
    return await deps.realpath(p);
  } catch {
    return p;
  }
}

/**
 * Where a new worktree's branch should start: null when the branch is already
 * local, `origin/<branch>` when it exists only on the remote.
 */
async function resolveStartPoint(
  target: TerminalTarget,
  notify: (msg: string) => void,
  deps: WorktreeDeps,
): Promise<string | null> {
  const { repoPath, branch } = target;
  if (await deps.hasRef(repoPath, `refs/heads/${branch}`)) return null;

  notify(`Fetching ${branch} from origin…`);
  // Best-effort: offline is survivable if the remote-tracking ref is already
  // present from an earlier fetch, so the failure is reported only if it isn't.
  try {
    await deps.git(repoPath, ["fetch", "origin", "--quiet"]);
  } catch (err) {
    deps.log(`fetch failed (continuing): ${err instanceof Error ? err.message : err}`);
  }

  if (!(await deps.hasRef(repoPath, `refs/remotes/origin/${branch}`))) {
    throw new Error(`Branch "${branch}" not found locally or on origin in ${repoPath}`);
  }
  return `origin/${branch}`;
}

/**
 * Reuses the worktree already standing where this PR's would go.
 *
 * It is on some other branch — a matching one was handled above — because the
 * directory name truncates the branch, or because something switched branches
 * inside it. Either way the directory belongs to this PR, so it is shared rather
 * than refused, which is what the whole path used to do.
 *
 * The switch is skipped outright when the worktree is dirty: git only refuses
 * a checkout when the dirty file is also touched by the branch being switched
 * to, so trusting it to protect uncommitted work would carry that work onto
 * the PR's branch silently whenever the two branches don't collide on the
 * same file. A terminal in the right directory on the wrong branch is far
 * more use than no terminal — the uncommitted work is usually the reason you
 * are opening one.
 */
async function reuseWorktree(
  target: TerminalTarget,
  occupant: WorktreeEntry,
  startPoint: string | null,
  notify: (msg: string) => void,
  deps: WorktreeDeps,
): Promise<string> {
  const was = occupant.branch ?? "a detached HEAD";
  notify(`Reusing worktree at ${occupant.path} (on ${was})…`);

  if (await hasUncommittedChanges(deps, occupant.path)) {
    notify(`Staying on ${was} — it has uncommitted changes.`);
    return occupant.path;
  }

  try {
    await deps.git(occupant.path, worktreeCheckoutArgv({ branch: target.branch, startPoint }));
    notify(`Switched it to ${target.branch}.`);
  } catch (err) {
    deps.log(`checkout in ${occupant.path} failed: ${err instanceof Error ? err.message : err}`);
    notify(
      `Could not switch it to ${target.branch} — staying on ${was}. Check for uncommitted changes.`,
    );
  }
  return occupant.path;
}
