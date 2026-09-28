import { describe, expect, it } from "vitest";
import type { PitwallWorktree, RepoConfig } from "@/types";
import {
  collectManagedWorktrees,
  findManagedWorktree,
  isManagedWorktree,
  managedWorktreeDir,
  planWorktreeRemoval,
  prNumberFromWorktreeDir,
  worktreeRemoveArgv,
} from "./terminalWorktrees";

const HOME = "/Users/dev";
const ROOT = "~/.pitwall/worktrees";

const billingApp: RepoConfig = {
  owner: "Northwind",
  name: "billing-app",
  localPath: "~/Dev/billing-app",
};

const managed = (repo: string, dir: string) =>
  `${HOME}/.pitwall/worktrees/${repo}/${dir}`;

describe("managedWorktreeDir", () => {
  it("expands ~ and flattens the repo to one directory", () => {
    expect(
      managedWorktreeDir({ root: ROOT, repo: "Northwind/billing-app", home: HOME }),
    ).toBe(`${HOME}/.pitwall/worktrees/Northwind-billing-app`);
  });
});

describe("isManagedWorktree", () => {
  const args = { root: ROOT, repo: "Northwind/billing-app", home: HOME };

  it("accepts a directory directly inside the repo's managed dir", () => {
    expect(isManagedWorktree(managed("Northwind-billing-app", "pr-1-x"), args)).toBe(
      true,
    );
  });

  it("refuses the main clone", () => {
    // The case that matters most: opening a terminal on a branch already checked
    // out in the main clone lands there, and removing it would be catastrophic.
    expect(isManagedWorktree(`${HOME}/Dev/billing-app`, args)).toBe(false);
  });

  it("refuses a hand-made worktree inside the clone", () => {
    expect(
      isManagedWorktree(`${HOME}/Dev/billing-app/.claude/worktrees/eng-1`, args),
    ).toBe(false);
  });

  it("refuses another repo's managed dir", () => {
    expect(isManagedWorktree(managed("Northwind-forms-app", "pr-1-x"), args)).toBe(
      false,
    );
  });

  it("refuses the managed dir itself", () => {
    expect(isManagedWorktree(managed("Northwind-billing-app", ""), args)).toBe(false);
  });

  it("refuses anything nested below a managed worktree", () => {
    // `startsWith(root)` would accept this; one path segment does not.
    expect(
      isManagedWorktree(managed("Northwind-billing-app", "pr-1-x/sub"), args),
    ).toBe(false);
  });

  it("refuses a traversal that resolves back out of the root", () => {
    expect(
      isManagedWorktree(managed("Northwind-billing-app", "../../../../etc"), args),
    ).toBe(false);
  });

  it("refuses an empty path", () => {
    expect(isManagedWorktree("", args)).toBe(false);
  });
});

describe("prNumberFromWorktreeDir", () => {
  it("reads the leading PR number", () => {
    expect(prNumberFromWorktreeDir("pr-3794-sam-eng-5604")).toBe(3794);
    expect(prNumberFromWorktreeDir("pr-12")).toBe(12);
  });

  it("rejects anything else", () => {
    expect(prNumberFromWorktreeDir("eng-5601-backfill")).toBeNull();
    expect(prNumberFromWorktreeDir("pr-abc-x")).toBeNull();
    expect(prNumberFromWorktreeDir("pr-0-x")).toBeNull();
    expect(prNumberFromWorktreeDir("xpr-1-y")).toBeNull();
  });
});

describe("worktreeRemoveArgv", () => {
  it("does not force by default", () => {
    const argv = worktreeRemoveArgv("/tmp/wt", false);
    expect(argv).toEqual(["worktree", "remove", "--", "/tmp/wt"]);
    expect(argv).not.toContain("--force");
  });

  it("forces only when asked, and keeps the -- separator", () => {
    expect(worktreeRemoveArgv("/tmp/wt", true)).toEqual([
      "worktree",
      "remove",
      "--force",
      "--",
      "/tmp/wt",
    ]);
  });
});

describe("collectManagedWorktrees", () => {
  const base = { worktreeRoot: ROOT, home: HOME };

  it("keeps only the worktrees Pitwall created", () => {
    const wt = managed("Northwind-billing-app", "pr-42-feature");
    expect(
      collectManagedWorktrees({
        ...base,
        worktrees: [
          {
            repo: billingApp,
            entries: [
              // The main clone and a hand-made worktree are both reused, never
              // owned — neither may ever reach `git worktree remove`.
              { path: `${HOME}/Dev/billing-app`, branch: "main" },
              {
                path: `${HOME}/Dev/billing-app/.claude/worktrees/eng-1`,
                branch: "eng-1",
              },
              { path: wt, branch: "feature" },
            ],
          },
        ],
      }),
    ).toEqual([
      {
        repo: "Northwind/billing-app",
        prNumber: 42,
        path: wt,
        branch: "feature",
        dirty: false,
      },
    ]);
  });

  it("ignores a managed directory that isn't named for a PR", () => {
    expect(
      collectManagedWorktrees({
        ...base,
        worktrees: [
          {
            repo: billingApp,
            entries: [{ path: managed("Northwind-billing-app", "scratch"), branch: "s" }],
          },
        ],
      }),
    ).toEqual([]);
  });

  it("marks the paths git status reported as dirty", () => {
    const wt = managed("Northwind-billing-app", "pr-42-feature");
    expect(
      collectManagedWorktrees({
        ...base,
        worktrees: [{ repo: billingApp, entries: [{ path: wt, branch: "feature" }] }],
        dirtyPaths: new Set([wt]),
      })[0].dirty,
    ).toBe(true);
  });
});

describe("findManagedWorktree", () => {
  const wt: PitwallWorktree = {
    repo: "Northwind/billing-app",
    prNumber: 42,
    path: managed("Northwind-billing-app", "pr-42-feature"),
    branch: "feature",
    dirty: false,
  };

  it("matches on repo and PR together", () => {
    expect(findManagedWorktree([wt], "Northwind/billing-app", 42)).toBe(wt);
    expect(findManagedWorktree([wt], "Northwind/billing-app", 43)).toBeNull();
    // Same PR number in a different repo must not match.
    expect(findManagedWorktree([wt], "Northwind/forms-app", 42)).toBeNull();
  });
});

describe("planWorktreeRemoval", () => {
  const clean: PitwallWorktree = {
    repo: "Northwind/billing-app",
    prNumber: 42,
    path: managed("Northwind-billing-app", "pr-42-feature"),
    branch: "feature",
    dirty: false,
  };

  it("removes a clean worktree", () => {
    expect(planWorktreeRemoval({ worktree: clean, force: false })).toEqual({
      path: clean.path,
      blocked: null,
    });
  });

  it("refuses a dirty one, and says why", () => {
    const plan = planWorktreeRemoval({
      worktree: { ...clean, dirty: true },
      force: false,
    });
    expect(plan.path).toBeNull();
    expect(plan.blocked).toMatch(/uncommitted/i);
  });

  it("removes a dirty one only when forced", () => {
    expect(
      planWorktreeRemoval({ worktree: { ...clean, dirty: true }, force: true }),
    ).toEqual({ path: clean.path, blocked: null });
  });

  it("does nothing, and warns about nothing, when there is no managed worktree", () => {
    // The common case: the terminal reused a checkout that already held the
    // branch. There is nothing of ours to remove and nothing to explain.
    expect(planWorktreeRemoval({ worktree: null, force: true })).toEqual({
      path: null,
      blocked: null,
    });
  });
});
