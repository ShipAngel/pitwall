import path from "node:path";
import type { PitwallWorktree, RepoConfig } from "@/types";
import { DEFAULT_WORKTREE_ROOT, expandHome, isValidPRNumber } from "./terminal";
import type { WorktreeEntry } from "./terminal";

/**
 * Which git worktrees Pitwall created, and may therefore delete.
 *
 * Its own module rather than more of `terminal.ts`: that file is about starting
 * and ending tmux sessions, and this is the half where a mistake deletes
 * someone's files. It earns its own tests and its own header.
 *
 * `isManagedWorktree` is the rule the module exists for. Opening a terminal does
 * not always create a worktree — `findWorktreeForBranch` reuses whatever already
 * holds the branch, which is routinely your main clone or one you made by hand.
 * Those are *borrowed*, never *owned*: ending their session is fine, removing
 * their directory is not. Only a directory sitting immediately under
 * `<worktreeRoot>/<owner-name>/` was created here.
 */

/** The directory Pitwall puts one repo's worktrees in. */
export function managedWorktreeDir(args: {
  root: string;
  repo: string;
  home: string;
}): string {
  return path.resolve(
    expandHome(args.root, args.home),
    args.repo.replace(/\//g, "-"),
  );
}

/**
 * Whether a worktree is one Pitwall created.
 *
 * True only for a directory *immediately* inside the repo's managed dir. The
 * single-segment requirement is deliberate: `startsWith(root)` — the obvious
 * version of this check — also accepts a nested path, and would accept anything
 * reachable through a symlink planted under the root.
 */
export function isManagedWorktree(
  candidate: string,
  args: { root: string; repo: string; home: string },
): boolean {
  if (!candidate) return false;
  const base = managedWorktreeDir(args);
  const rel = path.relative(base, path.resolve(candidate));
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return false;
  return !rel.includes(path.sep);
}

/** The PR a managed worktree directory belongs to, from its name. */
export function prNumberFromWorktreeDir(dirName: string): number | null {
  const m = /^pr-(\d+)(?:-|$)/.exec(dirName);
  if (!m) return null;
  const n = Number(m[1]);
  return isValidPRNumber(n) ? n : null;
}

/**
 * argv (after `git -C <repo>`) to remove a worktree.
 *
 * Not forced by default, and that is the point: `git worktree remove` refuses a
 * directory with uncommitted changes, so git's own check backs up ours. `--`
 * separates the path from anything that could read as a flag.
 */
export function worktreeRemoveArgv(worktreePath: string, force: boolean): string[] {
  return force
    ? ["worktree", "remove", "--force", "--", worktreePath]
    : ["worktree", "remove", "--", worktreePath];
}

/** One repo's `git worktree list` output, already parsed. */
export type RepoWorktrees = { repo: RepoConfig; entries: WorktreeEntry[] };

/**
 * The worktrees Pitwall created, across every configured repo.
 *
 * Everything else in the output — the main clone, hand-made worktrees, anything
 * whose directory name isn't `pr-<n>-…` — is dropped here, so nothing downstream
 * ever has to re-decide what is safe to remove.
 */
export function collectManagedWorktrees(args: {
  worktrees: RepoWorktrees[];
  worktreeRoot?: string;
  home: string;
  /** Absolute paths known to have uncommitted changes. */
  dirtyPaths?: Set<string>;
}): PitwallWorktree[] {
  const { worktrees, worktreeRoot = DEFAULT_WORKTREE_ROOT, home, dirtyPaths } = args;
  const found: PitwallWorktree[] = [];

  for (const { repo, entries } of worktrees) {
    const full = `${repo.owner}/${repo.name}`;
    for (const entry of entries) {
      if (!isManagedWorktree(entry.path, { root: worktreeRoot, repo: full, home })) {
        continue;
      }
      const prNumber = prNumberFromWorktreeDir(path.basename(entry.path));
      if (prNumber === null) continue;
      found.push({
        repo: full,
        prNumber,
        path: entry.path,
        branch: entry.branch,
        dirty: dirtyPaths?.has(entry.path) ?? false,
      });
    }
  }
  return found;
}

/** The managed worktree for one PR, if there is one. */
export function findManagedWorktree(
  worktrees: PitwallWorktree[],
  repo: string,
  prNumber: number,
): PitwallWorktree | null {
  return (
    worktrees.find((w) => w.repo === repo && w.prNumber === prNumber) ?? null
  );
}

export type WorktreeRemovalPlan = {
  /** The path to remove, or null when nothing should be. */
  path: string | null;
  /** Why a requested removal isn't happening. Not an error — the kill still ran. */
  blocked: string | null;
};

/**
 * Whether a requested worktree removal should go ahead.
 *
 * Separated from performing it so the refusal is unit-testable: the dirty check
 * is the difference between tidying up and destroying work, and it shouldn't
 * live only inside an async function that shells out.
 */
export function planWorktreeRemoval(args: {
  worktree: PitwallWorktree | null;
  force: boolean;
}): WorktreeRemovalPlan {
  const { worktree, force } = args;

  if (!worktree) {
    // Not an error and not worth a warning: a PR whose terminal reused an
    // existing checkout has no worktree of ours, which is the common case.
    return { path: null, blocked: null };
  }
  if (worktree.dirty && !force) {
    return {
      path: null,
      blocked: `${worktree.path} has uncommitted changes, so it was left alone. Commit or stash them, or choose "Delete anyway".`,
    };
  }
  return { path: worktree.path, blocked: null };
}
