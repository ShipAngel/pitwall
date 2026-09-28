import { describe, expect, it } from "vitest";
import {
  anyTtyOccupied,
  clampDockHeight,
  clampDragHeight,
  CLOSE_PTY_EXIT,
  CLOSE_SESSION_ENDED,
  CLOSE_SESSION_FAILED,
  closeDockTerminal,
  createKeyedSerializer,
  DEFAULT_TERMINAL_COMMAND,
  DOCK_DEFAULT_HEIGHT,
  DOCK_MAX_HEIGHT,
  DOCK_MIN_HEIGHT,
  dockTerminalForPR,
  EMPTY_DOCK,
  expandHome,
  findWorktreeAtPath,
  findWorktreeForBranch,
  isAllowedOrigin,
  isValidBranchName,
  isValidPRNumber,
  normalizeTty,
  openDockTerminal,
  parseSessionTtys,
  parseTerminalRuntime,
  parseTmuxPaneCwds,
  parseTmuxPaneTtys,
  parseTmuxSessions,
  parseWorktreeList,
  pitwallOwnedTtys,
  pitwallTerminalSessions,
  resolveTerminalTarget,
  sanitizeForTmux,
  shellQuote,
  terminalCapableRepos,
  terminalsEnabled,
  terminalSessionKey,
  terminalSocketUrl,
  terminalTabLabel,
  tmuxArgv,
  tmuxHasSessionArgv,
  tmuxKillSessionArgv,
  tmuxListSessionTtysArgv,
  tmuxSessionName,
  worktreeAddArgv,
  worktreeCheckoutArgv,
  worktreeDirName,
  worktreePath,
} from "./terminal";
import type { AppConfig, OpenTerminal } from "@/types";

const HOME = "/Users/alex";

const config = (overrides: Partial<AppConfig> = {}): AppConfig => ({
  repos: [
    { owner: "Northwind", name: "forms-app", localPath: "~/Dev/forms-app" },
    { owner: "Northwind", name: "no-clone" },
  ],
  linear: {
    teamKey: "ENG",
  },
  refreshIntervalSeconds: 60,
  terminals: { enabled: true },
  ...overrides,
});

const request = {
  repo: "Northwind/forms-app",
  prNumber: 1234,
  branch: "alex/eng-5500-copy-buttons",
};

describe("expandHome", () => {
  it("expands a leading ~/", () => {
    expect(expandHome("~/Dev/x", HOME)).toBe("/Users/alex/Dev/x");
  });

  it("expands a bare ~", () => {
    expect(expandHome("~", HOME)).toBe(HOME);
  });

  it("leaves absolute paths alone", () => {
    expect(expandHome("/opt/x", HOME)).toBe("/opt/x");
  });

  it("does not expand a ~ that is not leading", () => {
    expect(expandHome("/opt/~/x", HOME)).toBe("/opt/~/x");
  });

  it("does not expand ~user", () => {
    expect(expandHome("~bob/Dev", HOME)).toBe("~bob/Dev");
  });
});

describe("isValidBranchName", () => {
  it("accepts ordinary branch names", () => {
    expect(isValidBranchName("main")).toBe(true);
    expect(isValidBranchName("alex/eng-5500-copy-buttons")).toBe(true);
    expect(isValidBranchName("release/v1.2.3")).toBe(true);
    expect(isValidBranchName("fix_thing")).toBe(true);
  });

  it("rejects empty and over-long names", () => {
    expect(isValidBranchName("")).toBe(false);
    expect(isValidBranchName("a".repeat(256))).toBe(false);
  });

  it("rejects shell and path metacharacters", () => {
    for (const bad of [
      "a;rm -rf /",
      "a b",
      "a$(whoami)",
      "a`id`",
      "a|b",
      "a&b",
      "a>b",
      "a'b",
      'a"b',
      "a\nb",
      "a\\b",
      "café",
    ]) {
      expect(isValidBranchName(bad), bad).toBe(false);
    }
  });

  it("rejects names that could be read as a flag", () => {
    expect(isValidBranchName("-b")).toBe(false);
    expect(isValidBranchName("--force")).toBe(false);
  });

  it("rejects path traversal", () => {
    expect(isValidBranchName("../../etc/passwd")).toBe(false);
    expect(isValidBranchName("a/../b")).toBe(false);
    expect(isValidBranchName("a..b")).toBe(false);
  });

  it("rejects malformed slashes", () => {
    expect(isValidBranchName("/leading")).toBe(false);
    expect(isValidBranchName("trailing/")).toBe(false);
    expect(isValidBranchName("double//slash")).toBe(false);
  });

  it("applies git's own component rules", () => {
    expect(isValidBranchName("feature/.hidden")).toBe(false);
    expect(isValidBranchName(".hidden")).toBe(false);
    expect(isValidBranchName("feature/x.lock")).toBe(false);
    expect(isValidBranchName("trailing.")).toBe(false);
  });
});

describe("isValidPRNumber", () => {
  it("accepts positive integers", () => {
    expect(isValidPRNumber(1)).toBe(true);
    expect(isValidPRNumber(1234)).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isValidPRNumber(0)).toBe(false);
    expect(isValidPRNumber(-1)).toBe(false);
    expect(isValidPRNumber(1.5)).toBe(false);
    expect(isValidPRNumber("12")).toBe(false);
    expect(isValidPRNumber(NaN)).toBe(false);
    expect(isValidPRNumber(undefined)).toBe(false);
    expect(isValidPRNumber(10_000_000)).toBe(false);
  });
});

describe("sanitizeForTmux", () => {
  it("collapses characters tmux parses as addresses", () => {
    expect(sanitizeForTmux("a.b:c")).toBe("a-b-c");
  });

  it("keeps letters, digits, underscore and dash", () => {
    expect(sanitizeForTmux("Abc_1-2")).toBe("Abc_1-2");
  });

  it("collapses runs to a single dash", () => {
    expect(sanitizeForTmux("a...b")).toBe("a-b");
  });
});

describe("tmuxSessionName", () => {
  it("builds a name with no tmux metacharacters", () => {
    expect(tmuxSessionName("Northwind/forms-app", 1234)).toBe(
      "pitwall_Northwind-forms-app_1234",
    );
  });

  it("is stable for the same PR", () => {
    expect(tmuxSessionName("a/b", 1)).toBe(tmuxSessionName("a/b", 1));
  });

  it("distinguishes PRs in the same repo", () => {
    expect(tmuxSessionName("a/b", 1)).not.toBe(tmuxSessionName("a/b", 2));
  });

  it("distinguishes repos of the same name in different orgs", () => {
    expect(tmuxSessionName("x/app", 1)).not.toBe(tmuxSessionName("y/app", 1));
  });
});

describe("worktreeDirName", () => {
  it("leads with the PR number and flattens the branch", () => {
    expect(worktreeDirName(1234, "alex/eng-5500-copy")).toBe(
      "pr-1234-alex-eng-5500-copy",
    );
  });

  it("truncates a long branch", () => {
    const name = worktreeDirName(7, "x".repeat(200));
    expect(name.startsWith("pr-7-")).toBe(true);
    expect(name.length).toBeLessThanOrEqual(65);
  });

  it("stays unique when flattening collides", () => {
    // "a/b" and "a-b" flatten to the same string; the PR number keeps them apart.
    expect(worktreeDirName(1, "a/b")).not.toBe(worktreeDirName(2, "a-b"));
  });

  it("does not leave a trailing dash after truncation", () => {
    expect(worktreeDirName(1, `${"x".repeat(59)}/y`)).not.toMatch(/-$/);
  });
});

describe("worktreePath", () => {
  it("nests repo then PR under the expanded root", () => {
    expect(
      worktreePath({
        root: "~/.pitwall/worktrees",
        repo: "Northwind/forms-app",
        prNumber: 1234,
        branch: "alex/x",
        home: HOME,
      }),
    ).toBe(
      "/Users/alex/.pitwall/worktrees/Northwind-forms-app/pr-1234-alex-x",
    );
  });

  it("keeps different repos apart", () => {
    const base = { root: "/w", prNumber: 1, branch: "b", home: HOME };
    expect(worktreePath({ ...base, repo: "x/app" })).not.toBe(
      worktreePath({ ...base, repo: "y/app" }),
    );
  });
});

describe("parseWorktreeList", () => {
  const porcelain = [
    "worktree /Users/alex/Dev/forms-app",
    "HEAD abc123",
    "branch refs/heads/main",
    "",
    "worktree /Users/alex/.pitwall/worktrees/f/pr-1-feature-x",
    "HEAD def456",
    "branch refs/heads/feature/x",
    "",
    "worktree /Users/alex/detached",
    "HEAD 999",
    "detached",
    "",
  ].join("\n");

  it("reads every worktree", () => {
    expect(parseWorktreeList(porcelain)).toHaveLength(3);
  });

  it("strips refs/heads/ from branch names", () => {
    expect(parseWorktreeList(porcelain)[1]).toEqual({
      path: "/Users/alex/.pitwall/worktrees/f/pr-1-feature-x",
      branch: "feature/x",
    });
  });

  it("reports a detached worktree as having no branch", () => {
    expect(parseWorktreeList(porcelain)[2].branch).toBeNull();
  });

  it("handles empty output", () => {
    expect(parseWorktreeList("")).toEqual([]);
  });

  it("handles a trailing record with no blank line", () => {
    expect(parseWorktreeList("worktree /a\nbranch refs/heads/b")).toEqual([
      { path: "/a", branch: "b" },
    ]);
  });
});

describe("findWorktreeForBranch", () => {
  const entries = [
    { path: "/main", branch: "main" },
    { path: "/wt", branch: "feature/x" },
    { path: "/det", branch: null },
  ];

  it("finds the worktree holding a branch", () => {
    expect(findWorktreeForBranch(entries, "feature/x")).toBe("/wt");
  });

  it("returns null when no worktree has it", () => {
    expect(findWorktreeForBranch(entries, "other")).toBeNull();
  });

  it("does not match a detached worktree", () => {
    expect(findWorktreeForBranch(entries, null as unknown as string)).toBeNull();
  });
});

describe("findWorktreeAtPath", () => {
  const entries = [
    { path: "/root/repo", branch: "main" },
    { path: "/root/wt/pr-1-feature-x", branch: "other/branch" },
  ];

  it("finds the worktree standing at a path, whatever branch it holds", () => {
    expect(findWorktreeAtPath(entries, "/root/wt/pr-1-feature-x")).toEqual({
      path: "/root/wt/pr-1-feature-x",
      branch: "other/branch",
    });
  });

  it("compares resolved paths, so a trailing slash still matches", () => {
    expect(findWorktreeAtPath(entries, "/root/wt/pr-1-feature-x/")?.branch).toBe(
      "other/branch",
    );
  });

  it("returns null for a free path", () => {
    expect(findWorktreeAtPath(entries, "/root/wt/pr-2-other")).toBeNull();
  });

  it("returns null for an empty path rather than matching anything", () => {
    expect(findWorktreeAtPath(entries, "")).toBeNull();
  });
});

describe("worktreeCheckoutArgv", () => {
  it("switches an existing worktree to a local branch", () => {
    expect(
      worktreeCheckoutArgv({ branch: "feature/x", startPoint: null }),
    ).toEqual(["checkout", "feature/x"]);
  });

  it("creates a tracking branch when the branch is remote-only", () => {
    expect(
      worktreeCheckoutArgv({
        branch: "feature/x",
        startPoint: "origin/feature/x",
      }),
    ).toEqual(["checkout", "--track", "-b", "feature/x", "origin/feature/x"]);
  });
});

describe("shellQuote", () => {
  it("leaves safe words unquoted", () => {
    expect(shellQuote(["claude"])).toBe("claude");
    expect(shellQuote(["claude", "--continue"])).toBe("claude --continue");
  });

  it("quotes words containing spaces", () => {
    expect(shellQuote(["claude", "-p", "fix the bug"])).toBe(
      "claude -p 'fix the bug'",
    );
  });

  it("escapes embedded single quotes", () => {
    expect(shellQuote(["echo", "it's"])).toBe(`echo 'it'\\''s'`);
  });

  it("quotes shell metacharacters", () => {
    expect(shellQuote(["a;b"])).toBe("'a;b'");
    expect(shellQuote(["$(id)"])).toBe("'$(id)'");
  });
});

describe("tmuxArgv", () => {
  const argv = tmuxArgv({
    sessionName: "pitwall_a_1",
    cwd: "/wt",
    command: ["claude"],
  });

  it("attaches to an existing session rather than creating a second", () => {
    expect(argv).toContain("-A");
  });

  it("names the session and sets the working directory", () => {
    expect(argv).toEqual([
      "new-session",
      "-A",
      "-s",
      "pitwall_a_1",
      "-c",
      "/wt",
      "claude",
    ]);
  });

  it("passes a multi-word command as one quoted argument", () => {
    const withArgs = tmuxArgv({
      sessionName: "s",
      cwd: "/wt",
      command: ["claude", "--continue"],
    });
    expect(withArgs[withArgs.length - 1]).toBe("claude --continue");
    expect(withArgs).toHaveLength(7);
  });
});

describe("worktreeAddArgv", () => {
  it("checks out an existing local branch", () => {
    expect(
      worktreeAddArgv({ worktreePath: "/wt", branch: "feature/x", startPoint: null }),
    ).toEqual(["worktree", "add", "--", "/wt", "feature/x"]);
  });

  it("creates a tracking branch from a remote start point", () => {
    expect(
      worktreeAddArgv({
        worktreePath: "/wt",
        branch: "feature/x",
        startPoint: "origin/feature/x",
      }),
    ).toEqual([
      "worktree",
      "add",
      "--track",
      "-b",
      "feature/x",
      "--",
      "/wt",
      "origin/feature/x",
    ]);
  });

  it("separates the path from flags with --", () => {
    const argv = worktreeAddArgv({
      worktreePath: "/wt",
      branch: "b",
      startPoint: null,
    });
    expect(argv.indexOf("--")).toBeLessThan(argv.indexOf("/wt"));
  });
});

describe("terminalsEnabled", () => {
  it("is false when the block is absent", () => {
    expect(terminalsEnabled(config({ terminals: undefined }))).toBe(false);
  });

  it("is false when explicitly disabled", () => {
    expect(terminalsEnabled(config({ terminals: { enabled: false } }))).toBe(false);
  });

  it("is true only when explicitly enabled", () => {
    expect(terminalsEnabled(config())).toBe(true);
  });
});

describe("dock transitions", () => {
  const pr = (number: number, over: Partial<Parameters<typeof dockTerminalForPR>[0]> = {}) =>
    dockTerminalForPR({
      repo: "Northwind/forms-app",
      number,
      headRefName: `branch-${number}`,
      title: `PR ${number}`,
      ...over,
    });

  /** Builds a dock with the given PRs open and the last one active. */
  const dockWith = (...numbers: number[]) =>
    numbers.reduce((d, n) => openDockTerminal(d, pr(n)), EMPTY_DOCK);

  describe("dockTerminalForPR", () => {
    it("snapshots the PR into a keyed entry", () => {
      expect(pr(7)).toEqual({
        key: "Northwind/forms-app#7",
        repo: "Northwind/forms-app",
        prNumber: 7,
        branch: "branch-7",
        title: "PR 7",
      });
    });
  });

  describe("openDockTerminal", () => {
    it("opens and activates a terminal", () => {
      const d = openDockTerminal(EMPTY_DOCK, pr(1));
      expect(d.terminals).toHaveLength(1);
      expect(d.activeKey).toBe("Northwind/forms-app#1");
    });

    it("appends, keeping earlier terminals open", () => {
      expect(dockWith(1, 2, 3).terminals.map((t) => t.prNumber)).toEqual([1, 2, 3]);
    });

    it("brings an already-open terminal forward instead of duplicating it", () => {
      const d = openDockTerminal(dockWith(1, 2), pr(1));
      expect(d.terminals).toHaveLength(2);
      expect(d.activeKey).toBe("Northwind/forms-app#1");
    });

    it("does not mutate the state it is given", () => {
      const before = dockWith(1);
      const snapshot = { terminals: [...before.terminals], activeKey: before.activeKey };
      openDockTerminal(before, pr(2));
      expect(before).toEqual(snapshot);
    });
  });

  describe("closeDockTerminal", () => {
    it("removes the terminal", () => {
      const d = closeDockTerminal(dockWith(1, 2, 3), "Northwind/forms-app#2");
      expect(d.terminals.map((t) => t.prNumber)).toEqual([1, 3]);
    });

    it("activates the tab that slides into the closed one's place", () => {
      // Four tabs, so the neighbour and the *last* tab are different answers —
      // with three, closing the middle one makes them coincide and the test
      // passes either way.
      const start = { ...dockWith(1, 2, 3, 4), activeKey: "Northwind/forms-app#2" };
      expect(closeDockTerminal(start, "Northwind/forms-app#2").activeKey).toBe(
        "Northwind/forms-app#3",
      );
    });

    it("falls back to the previous tab when the last one closes", () => {
      expect(closeDockTerminal(dockWith(1, 2, 3), "Northwind/forms-app#3").activeKey).toBe(
        "Northwind/forms-app#2",
      );
    });

    it("leaves the selection alone when closing an inactive tab", () => {
      const start = { ...dockWith(1, 2, 3), activeKey: "Northwind/forms-app#3" };
      expect(closeDockTerminal(start, "Northwind/forms-app#1").activeKey).toBe(
        "Northwind/forms-app#3",
      );
    });

    it("clears the active key when the last terminal closes", () => {
      const d = closeDockTerminal(dockWith(1), "Northwind/forms-app#1");
      expect(d.terminals).toEqual([]);
      expect(d.activeKey).toBeNull();
    });

    it("is a no-op for a key that isn't open", () => {
      const start = dockWith(1, 2);
      expect(closeDockTerminal(start, "nope")).toBe(start);
    });

    it("is idempotent, so a doubled updater call converges", () => {
      // React may invoke an updater more than once; applying twice must not
      // close a second tab.
      const start = { ...dockWith(1, 2, 3), activeKey: "Northwind/forms-app#2" };
      const once = closeDockTerminal(start, "Northwind/forms-app#2");
      expect(closeDockTerminal(once, "Northwind/forms-app#2")).toEqual(once);
    });

    it("does not mutate the state it is given", () => {
      const before = dockWith(1, 2);
      const snapshot = { terminals: [...before.terminals], activeKey: before.activeKey };
      closeDockTerminal(before, "Northwind/forms-app#1");
      expect(before).toEqual(snapshot);
    });
  });
});

describe("createKeyedSerializer", () => {
  /** A promise plus the handles to settle it, so a test controls the timing. */
  function deferred<T>() {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  it("runs the work once for concurrent callers on the same key", async () => {
    const serialize = createKeyedSerializer<string>();
    const d = deferred<string>();
    let runs = 0;
    const work = () => {
      runs++;
      return d.promise;
    };

    const a = serialize("k", work);
    const b = serialize("k", work);
    d.resolve("done");

    expect(await a).toBe("done");
    expect(await b).toBe("done");
    // The point of the whole thing: the second caller must not start a second
    // `git worktree add` on the same checkout.
    expect(runs).toBe(1);
  });

  it("gives both callers the same result", async () => {
    const serialize = createKeyedSerializer<string>();
    const d = deferred<string>();
    const a = serialize("k", () => d.promise);
    const b = serialize("k", () => d.promise);
    d.resolve("shared");
    expect(await Promise.all([a, b])).toEqual(["shared", "shared"]);
  });

  it("does not serialize different keys against each other", async () => {
    const serialize = createKeyedSerializer<string>();
    let runs = 0;
    const work = (v: string) => () => {
      runs++;
      return Promise.resolve(v);
    };
    expect(await Promise.all([serialize("a", work("a")), serialize("b", work("b"))])).toEqual([
      "a",
      "b",
    ]);
    expect(runs).toBe(2);
  });

  it("re-runs after settling, so a deleted worktree is rebuilt", async () => {
    const serialize = createKeyedSerializer<string>();
    let runs = 0;
    const work = () => {
      runs++;
      return Promise.resolve("v");
    };
    await serialize("k", work);
    await serialize("k", work);
    expect(runs).toBe(2);
  });

  it("rejects every waiter when the work fails", async () => {
    const serialize = createKeyedSerializer<string>();
    const d = deferred<string>();
    const a = serialize("k", () => d.promise);
    const b = serialize("k", () => d.promise);
    d.reject(new Error("worktree add failed"));
    await expect(a).rejects.toThrow(/worktree add failed/);
    await expect(b).rejects.toThrow(/worktree add failed/);
  });

  it("does not cache a failure — the next call retries", async () => {
    const serialize = createKeyedSerializer<string>();
    let runs = 0;
    const work = () => {
      runs++;
      return runs === 1 ? Promise.reject(new Error("transient")) : Promise.resolve("ok");
    };
    await expect(serialize("k", work)).rejects.toThrow(/transient/);
    await expect(serialize("k", work)).resolves.toBe("ok");
    expect(runs).toBe(2);
  });
});

describe("terminalCapableRepos", () => {
  it("returns only repos with a localPath", () => {
    expect(terminalCapableRepos(config()).map((r) => r.name)).toEqual([
      "forms-app",
    ]);
  });

  it("returns nothing when terminals are off", () => {
    expect(terminalCapableRepos(config({ terminals: { enabled: false } }))).toEqual(
      [],
    );
  });
});

describe("resolveTerminalTarget", () => {
  it("derives every path and argument from config", () => {
    expect(
      resolveTerminalTarget({ config: config(), request, home: HOME }),
    ).toEqual({
      sessionName: "pitwall_Northwind-forms-app_1234",
      repoPath: "/Users/alex/Dev/forms-app",
      worktreePath:
        "/Users/alex/.pitwall/worktrees/Northwind-forms-app/pr-1234-alex-eng-5500-copy-buttons",
      branch: "alex/eng-5500-copy-buttons",
      command: DEFAULT_TERMINAL_COMMAND,
    });
  });

  it("matches the repo case-insensitively and names everything in config's spelling", () => {
    // GitHub may report "NORTHWIND/Forms-App" for a repo config.json spells
    // "Northwind/forms-app". The session name must be the config's, or the
    // Sessions panel - which derives names from config - never lists it.
    const target = resolveTerminalTarget({
      config: config(),
      request: { ...request, repo: "NORTHWIND/Forms-App" },
      home: HOME,
    });
    expect(target.sessionName).toBe("pitwall_Northwind-forms-app_1234");
    expect(target.worktreePath).toContain("/Northwind-forms-app/");
  });

  it("honours a configured command and worktree root", () => {
    const target = resolveTerminalTarget({
      config: config({
        terminals: {
          enabled: true,
          worktreeRoot: "/scratch/wt",
          command: ["claude", "--continue"],
        },
      }),
      request,
      home: HOME,
    });
    expect(target.command).toEqual(["claude", "--continue"]);
    expect(target.worktreePath.startsWith("/scratch/wt/")).toBe(true);
  });

  it("refuses when terminals are disabled", () => {
    expect(() =>
      resolveTerminalTarget({
        config: config({ terminals: { enabled: false } }),
        request,
        home: HOME,
      }),
    ).toThrow(/disabled/);
  });

  it("refuses a repo that is not in config.json", () => {
    expect(() =>
      resolveTerminalTarget({
        config: config(),
        request: { ...request, repo: "attacker/evil" },
        home: HOME,
      }),
    ).toThrow(/not in config\.json/);
  });

  it("refuses a configured repo with no local clone", () => {
    expect(() =>
      resolveTerminalTarget({
        config: config(),
        request: { ...request, repo: "Northwind/no-clone" },
        home: HOME,
      }),
    ).toThrow(/No localPath/);
  });

  it("refuses an unsafe branch name before it reaches any argv", () => {
    expect(() =>
      resolveTerminalTarget({
        config: config(),
        request: { ...request, branch: "x;rm -rf /" },
        home: HOME,
      }),
    ).toThrow(/Invalid branch name/);
  });

  it("refuses a non-integer PR number", () => {
    expect(() =>
      resolveTerminalTarget({
        config: config(),
        request: { ...request, prNumber: 1.5 },
        home: HOME,
      }),
    ).toThrow(/Invalid PR number/);
  });
});

describe("isAllowedOrigin", () => {
  it("accepts the app's own origin", () => {
    expect(isAllowedOrigin("http://localhost:3737", 3737)).toBe(true);
    expect(isAllowedOrigin("http://127.0.0.1:3737", 3737)).toBe(true);
  });

  it("rejects a missing Origin header", () => {
    expect(isAllowedOrigin(undefined, 3737)).toBe(false);
    expect(isAllowedOrigin("", 3737)).toBe(false);
  });

  it("rejects other sites, ports and schemes", () => {
    expect(isAllowedOrigin("http://evil.com", 3737)).toBe(false);
    expect(isAllowedOrigin("http://localhost:3000", 3737)).toBe(false);
    expect(isAllowedOrigin("https://localhost:3737", 3737)).toBe(false);
    expect(isAllowedOrigin("http://localhost:3737.evil.com", 3737)).toBe(false);
  });
});

describe("clampDockHeight", () => {
  it("accepts an in-range stored string", () => {
    expect(clampDockHeight("500")).toBe(500);
  });

  it("falls back rather than clamping a junk value", () => {
    // A stored 0 means the value is unusable, not "as short as possible".
    expect(clampDockHeight("0")).toBe(DOCK_DEFAULT_HEIGHT);
    expect(clampDockHeight("99999")).toBe(DOCK_DEFAULT_HEIGHT);
    expect(clampDockHeight(null)).toBe(DOCK_DEFAULT_HEIGHT);
    expect(clampDockHeight("abc")).toBe(DOCK_DEFAULT_HEIGHT);
    expect(clampDockHeight("")).toBe(DOCK_DEFAULT_HEIGHT);
    expect(clampDockHeight(undefined)).toBe(DOCK_DEFAULT_HEIGHT);
    expect(clampDockHeight(Infinity)).toBe(DOCK_DEFAULT_HEIGHT);
  });

  it("accepts the exact bounds", () => {
    expect(clampDockHeight(DOCK_MIN_HEIGHT)).toBe(DOCK_MIN_HEIGHT);
    expect(clampDockHeight(DOCK_MAX_HEIGHT)).toBe(DOCK_MAX_HEIGHT);
  });
});

describe("clampDragHeight", () => {
  it("clamps rather than falling back, so a drag stops at the edge", () => {
    expect(clampDragHeight(10)).toBe(DOCK_MIN_HEIGHT);
    expect(clampDragHeight(99999)).toBe(DOCK_MAX_HEIGHT);
  });

  it("passes an in-range drag through", () => {
    expect(clampDragHeight(400)).toBe(400);
  });

  it("rounds sub-pixel drags", () => {
    expect(clampDragHeight(400.6)).toBe(401);
  });
});

describe("terminalSessionKey", () => {
  it("is unique per repo and PR", () => {
    expect(terminalSessionKey("a/app", 1)).toBe("a/app#1");
    expect(terminalSessionKey("a/app", 1)).not.toBe(terminalSessionKey("a/app", 2));
    expect(terminalSessionKey("a/app", 1)).not.toBe(terminalSessionKey("b/app", 1));
  });
});

describe("terminalTabLabel", () => {
  it("drops the owner", () => {
    expect(terminalTabLabel("Northwind/forms-app", 1234)).toBe(
      "forms-app #1234",
    );
  });

  it("copes with a repo that has no owner segment", () => {
    expect(terminalTabLabel("forms-app", 7)).toBe("forms-app #7");
  });
});

describe("terminalSocketUrl", () => {
  const args = {
    wsUrl: "ws://127.0.0.1:3738",
    token: "tok",
    repo: "Northwind/forms-app",
    prNumber: 1234,
    branch: "alex/eng-1",
    cols: 120,
    rows: 30,
  };

  it("carries the token, PR identity and starting size", () => {
    const url = new URL(terminalSocketUrl(args));
    expect(url.protocol).toBe("ws:");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      token: "tok",
      repo: "Northwind/forms-app",
      pr: "1234",
      branch: "alex/eng-1",
      cols: "120",
      rows: "30",
    });
  });

  it("percent-encodes the slash in a repo or branch", () => {
    expect(terminalSocketUrl(args)).toContain("repo=Northwind%2Fforms-app");
  });

  it("does not double the slash when wsUrl has a trailing one", () => {
    expect(terminalSocketUrl({ ...args, wsUrl: "ws://127.0.0.1:3738/" })).toContain(
      "ws://127.0.0.1:3738/?",
    );
  });
});

describe("parseTerminalRuntime", () => {
  it("reads a well-formed runtime file", () => {
    expect(parseTerminalRuntime('{"port":3738,"token":"abc"}')).toEqual({
      port: 3738,
      token: "abc",
    });
  });

  it("rejects a missing or empty token", () => {
    expect(() => parseTerminalRuntime('{"port":3738}')).toThrow(/'token'/);
    expect(() => parseTerminalRuntime('{"port":3738,"token":""}')).toThrow(/'token'/);
  });

  it("rejects a bad port", () => {
    expect(() => parseTerminalRuntime('{"port":0,"token":"a"}')).toThrow(/'port'/);
    expect(() => parseTerminalRuntime('{"port":"3738","token":"a"}')).toThrow(
      /'port'/,
    );
  });

  it("rejects non-object JSON", () => {
    expect(() => parseTerminalRuntime("null")).toThrow(/must be a JSON object/);
    expect(() => parseTerminalRuntime('"x"')).toThrow(/must be a JSON object/);
  });
});

describe("parseTmuxSessions", () => {
  it("reads name, creation time and attachment", () => {
    expect(
      parseTmuxSessions("pitwall_a_1|1786025940|0\npitwall_b_2|1786026000|1"),
    ).toEqual([
      { name: "pitwall_a_1", created: 1786025940, attached: false },
      { name: "pitwall_b_2", created: 1786026000, attached: true },
    ]);
  });

  it("treats any number of clients as attached", () => {
    // session_attached is a client count, not a flag — two dashboard tabs with
    // the same PR's pane open make it "2". Compared against "1" that read as
    // detached, which is exactly backwards. Verified against real tmux.
    expect(parseTmuxSessions("s|1786025940|2")[0].attached).toBe(true);
    expect(parseTmuxSessions("s|1786025940|10")[0].attached).toBe(true);
    expect(parseTmuxSessions("s|1786025940|0")[0].attached).toBe(false);
  });

  it("returns nothing for empty output", () => {
    // tryCommand yields "" when tmux is absent, which must not throw.
    expect(parseTmuxSessions("")).toEqual([]);
  });

  it("drops malformed lines rather than failing the list", () => {
    expect(
      parseTmuxSessions("good|1786025940|0\ngarbage\nbad|notanumber|0"),
    ).toEqual([{ name: "good", created: 1786025940, attached: false }]);
  });
});

describe("parseTmuxPaneTtys", () => {
  it("maps each tty to its session, normalising /dev/", () => {
    const map = parseTmuxPaneTtys("s1|/dev/ttys009\ns2|/dev/ttys010");
    expect(map.get("ttys009")).toBe("s1");
    expect(map.get("ttys010")).toBe("s2");
  });

  it("ignores incomplete lines", () => {
    expect(parseTmuxPaneTtys("s1|\n|/dev/ttys009\n").size).toBe(0);
  });
});

describe("normalizeTty", () => {
  it("reduces both spellings to the bare device", () => {
    // ps says ttys001, tmux and iTerm2 say /dev/ttys001; everything joins here.
    expect(normalizeTty("/dev/ttys001")).toBe("ttys001");
    expect(normalizeTty("ttys001")).toBe("ttys001");
  });
});

describe("parseTmuxPaneCwds", () => {
  it("maps a session to its pane's working directory", () => {
    expect(
      parseTmuxPaneCwds("pitwall_a_1|/dev/ttys009|/Users/dev/Dev/a"),
    ).toEqual(new Map([["pitwall_a_1", "/Users/dev/Dev/a"]]));
  });

  it("keeps a path containing the field separator intact", () => {
    // The path is last and rejoined, so a "|" in a directory name shifts
    // nothing — parsing it as parts[2] would truncate silently.
    expect(
      parseTmuxPaneCwds("s|/dev/ttys1|/Users/dev/we|rd").get("s"),
    ).toBe("/Users/dev/we|rd");
  });

  it("takes the first pane where a session has several", () => {
    expect(
      parseTmuxPaneCwds("s|/dev/ttys1|/first\ns|/dev/ttys2|/second").get("s"),
    ).toBe("/first");
  });

  it("drops lines from the old two-field format rather than inventing a cwd", () => {
    expect(parseTmuxPaneCwds("s|/dev/ttys1").size).toBe(0);
    expect(parseTmuxPaneCwds("").size).toBe(0);
  });
});

describe("pitwallTerminalSessions", () => {
  const cfg = (repos: { owner: string; name: string }[]): AppConfig => ({
    ...config(),
    repos,
  });
  const rows = (...names: string[]) =>
    names.map((name) => ({ name, created: 1786025940, attached: false }));

  it("resolves a session name back to its repo and PR", () => {
    expect(
      pitwallTerminalSessions({
        rows: rows("pitwall_Northwind-forms-app_1234"),
        config: cfg([{ owner: "Northwind", name: "forms-app" }]),
      }),
    ).toEqual([
      {
        sessionName: "pitwall_Northwind-forms-app_1234",
        repo: "Northwind/forms-app",
        prNumber: 1234,
        createdAt: new Date(1786025940 * 1000).toISOString(),
        attached: false,
        // No pane map supplied, so there is nowhere to have learnt a cwd.
        cwd: null,
      },
    ]);
  });

  it("carries the pane's working directory when one is known", () => {
    expect(
      pitwallTerminalSessions({
        rows: rows("pitwall_Northwind-forms-app_1234"),
        config: cfg([{ owner: "Northwind", name: "forms-app" }]),
        cwds: new Map([["pitwall_Northwind-forms-app_1234", "/Users/dev/Dev/forms-app"]]),
      })[0].cwd,
    ).toBe("/Users/dev/Dev/forms-app");
  });

  it("ignores tmux sessions this app didn't create", () => {
    expect(
      pitwallTerminalSessions({
        rows: rows("my-own-session", "work", "pitwall"),
        config: cfg([{ owner: "Northwind", name: "forms-app" }]),
      }),
    ).toEqual([]);
  });

  it("ignores a session whose repo is no longer configured", () => {
    // Matched forwards against config, so an unresolvable name yields no row
    // rather than a half-known one offering actions it can't perform.
    expect(
      pitwallTerminalSessions({
        rows: rows("pitwall_Northwind-forms-app_1234"),
        config: cfg([{ owner: "Northwind", name: "billing-app" }]),
      }),
    ).toEqual([]);
  });

  it("refuses to resolve a session two repos could both claim", () => {
    // sanitizeForTmux maps "." and "-" alike, so "forms.app" and
    // "forms-app" produce the same session name. Picking one would mean a
    // row that can open — or *end* — the other repo's session, with a live
    // Claude in it. validateConfig rejects such a config outright when
    // terminals are on; this is the second lock, so no row is offered at all.
    expect(
      pitwallTerminalSessions({
        rows: rows("pitwall_Northwind-forms-app_1234"),
        config: cfg([
          { owner: "Northwind", name: "forms.app" },
          { owner: "Northwind", name: "forms-app" },
        ]),
      }),
    ).toEqual([]);
  });

  it("still resolves when the same repo appears twice", () => {
    // A duplicate entry is not a collision — both names are the same repo, so
    // there is nothing ambiguous to protect against.
    const result = pitwallTerminalSessions({
      rows: rows("pitwall_Northwind-forms-app_1234"),
      config: cfg([
        { owner: "Northwind", name: "forms-app" },
        { owner: "Northwind", name: "forms-app" },
      ]),
    });
    expect(result).toHaveLength(1);
    expect(result[0].repo).toBe("Northwind/forms-app");
  });

  it("rejects an implausible PR number", () => {
    expect(
      pitwallTerminalSessions({
        rows: rows("pitwall_Northwind-forms-app_0"),
        config: cfg([{ owner: "Northwind", name: "forms-app" }]),
      }),
    ).toEqual([]);
  });
});

describe("pitwallOwnedTtys", () => {
  const session = (sessionName: string, prNumber: number) => ({
    sessionName,
    repo: "Northwind/forms-app",
    prNumber,
    createdAt: "2026-08-06T00:00:00.000Z",
    attached: false,
    cwd: null,
  });

  it("collects the ttys belonging to hosted sessions", () => {
    expect(
      pitwallOwnedTtys({
        paneTtys: new Map([
          ["ttys009", "pitwall_x_1"],
          ["ttys010", "someone-elses-session"],
        ]),
        sessions: [session("pitwall_x_1", 1)],
      }),
    ).toEqual(new Set(["ttys009"]));
  });

  it("claims nothing when no session is hosted", () => {
    expect(
      pitwallOwnedTtys({
        paneTtys: new Map([["ttys009", "pitwall_x_1"]]),
        sessions: [],
      }).size,
    ).toBe(0);
  });
});

describe("tmuxKillSessionArgv", () => {
  it("anchors the target to an exact match", () => {
    // Without the "=", tmux falls back to prefix then fnmatch matching — so
    // killing "pitwall_a_1" could take out "pitwall_a_12" instead.
    expect(tmuxKillSessionArgv("pitwall_a_1")).toEqual([
      "kill-session",
      "-t",
      "=pitwall_a_1",
    ]);
  });
});

describe("tmuxListSessionTtysArgv", () => {
  it("targets an exact session, across all its windows, and asks only for ttys", () => {
    expect(tmuxListSessionTtysArgv("pitwall_a_1")).toEqual([
      "list-panes",
      "-s",
      "-t",
      "=pitwall_a_1",
      "-F",
      "#{pane_tty}",
    ]);
  });
});

describe("parseSessionTtys", () => {
  it("normalises and drops blanks", () => {
    expect(parseSessionTtys("/dev/ttys009\n\n/dev/ttys010\n")).toEqual([
      "ttys009",
      "ttys010",
    ]);
  });

  it("is empty when tmux said nothing", () => {
    expect(parseSessionTtys("")).toEqual([]);
  });
});

describe("anyTtyOccupied", () => {
  const PS_OUT = ["TTY      COMM", "ttys009  claude", "ttys001  -zsh"].join("\n");

  it("sees a process still on the tty", () => {
    // This is the condition the kill route waits out — while it holds, the
    // killed session shows up in the discovered list instead of vanishing.
    expect(anyTtyOccupied(PS_OUT, ["ttys009"])).toBe(true);
  });

  it("is false once the tty is clear", () => {
    expect(anyTtyOccupied(PS_OUT, ["ttys025"])).toBe(false);
  });

  it("matches either spelling of the device", () => {
    expect(anyTtyOccupied(PS_OUT, ["/dev/ttys009"])).toBe(true);
  });

  it("is false when there are no ttys to wait on", () => {
    expect(anyTtyOccupied(PS_OUT, [])).toBe(false);
  });

  it("does not treat the header row as a process", () => {
    expect(anyTtyOccupied(PS_OUT, ["TTY"])).toBe(false);
  });
});

describe("tmuxHasSessionArgv", () => {
  it("anchors the target to an exact match", () => {
    expect(tmuxHasSessionArgv("pitwall_a_1")).toEqual([
      "has-session",
      "-t",
      "=pitwall_a_1",
    ]);
  });
});

describe("close reasons", () => {
  it("keeps detach and end distinguishable", () => {
    // The pty exits for both, and only the sidecar can ask tmux which happened.
    // Collapsed to one reason, the UI reports "still running" over a session
    // that was just killed and offers a Reconnect that would silently create a
    // new one, because tmuxArgv uses `new-session -A`.
    expect(CLOSE_PTY_EXIT).not.toBe(CLOSE_SESSION_ENDED);
    expect(CLOSE_SESSION_FAILED).not.toBe(CLOSE_SESSION_ENDED);
  });
});

describe("dock keys across repo casing", () => {
  const pane = (key: string) => ({ key }) as unknown as OpenTerminal;

  it("closes a pane whose key differs from the panel's only in case", () => {
    const state = { terminals: [pane("Acme/api#12")], activeKey: "Acme/api#12" };
    expect(closeDockTerminal(state, "acme/api#12")).toEqual({ terminals: [], activeKey: null });
  });

  it("brings the existing pane forward instead of opening a duplicate", () => {
    const state = { terminals: [pane("Acme/api#12")], activeKey: null };
    const next = openDockTerminal(state, pane("acme/api#12"));
    expect(next.terminals).toHaveLength(1);
    expect(next.activeKey).toBe("Acme/api#12");
  });
});
