import { WORKTREE_REMOVE_TIMEOUT_MS } from "@/lib/timeouts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Route-level tests for ending a hosted terminal and removing its worktree.
 *
 * The decisions — what counts as a worktree Pitwall created, what a dirty one
 * blocks — are unit tested in `lib/terminalWorktrees.test.ts`. These cover the
 * wiring those can't: which subprocesses run, in what order, and what the
 * browser is and isn't allowed to influence.
 *
 * `@/lib/exec` is replaced rather than `node:child_process`, for the reason
 * given in that module.
 */

const tryCommand = vi.hoisted(() => vi.fn());
const runCommand = vi.hoisted(() => vi.fn());
vi.mock("@/lib/exec", () => ({ tryCommand, runCommand, DEFAULT_TIMEOUT_MS: 10_000 }));

const readConfig = vi.hoisted(() => vi.fn());
vi.mock("@/lib/config", () => ({ readConfig }));

const homedir = vi.hoisted(() => vi.fn(() => "/Users/dev"));
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  homedir,
}));

const CONFIG = {
  // "~/…" on purpose: `git -C` gets no shell, so an unexpanded tilde silently
  // finds no worktrees — and because discovery uses tryCommand, the route would
  // just report nothing to remove. An absolute fixture hides that.
  repos: [
    { owner: "Northwind", name: "billing-app", localPath: "~/Dev/billing-app" },
    { owner: "Northwind", name: "no-clone" },
  ],
  linear: { teamKey: "ENG" },
  refreshIntervalSeconds: 300,
  terminals: { enabled: true, worktreeRoot: "~/.pitwall/worktrees" },
};

const REPO_PATH = "/Users/dev/Dev/billing-app";
const MANAGED =
  "/Users/dev/.pitwall/worktrees/Northwind-billing-app/pr-42-feature";
const SESSION = "pitwall_Northwind-billing-app_42";

const WORKTREES = [
  `worktree ${REPO_PATH}`,
  "branch refs/heads/main",
  "",
  `worktree ${MANAGED}`,
  "branch refs/heads/feature",
  "",
].join("\n");

function stubLocal({ dirty = false }: { dirty?: boolean } = {}) {
  tryCommand.mockImplementation(async (cmd: string, args: string[]) => {
    if (cmd === "tmux" && args.includes("list-panes")) return "/dev/ttys009\n";
    if (cmd === "ps") return "TTY      COMM\nttys001  zsh";
    if (cmd === "git" && args.includes("worktree") && args.includes("list")) {
      return args[1] === REPO_PATH ? WORKTREES : "";
    }
    return "";
  });
  // The clean check goes through runCommand, so that a failing `git status`
  // throws rather than reading as clean.
  runCommand.mockImplementation(async (cmd: string, args: string[]) =>
    cmd === "git" && args.includes("status") && dirty ? " M a.ts\n" : "",
  );
}

const HEADERS = { origin: "http://localhost:3737", host: "localhost:3737" };

async function callPOST(
  body: unknown,
  headers: Record<string, string> = HEADERS,
) {
  const { POST } = await import("@/app/api/terminal/kill/route");
  return POST(
    new Request("http://localhost:3737/api/terminal/kill", {
      method: "POST",
      headers,
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

/** The git commands that change something: everything but the clean check. */
const gitCalls = () =>
  runCommand.mock.calls
    .filter(([cmd, args]) => cmd === "git" && !(args as string[]).includes("status"))
    .map(([, args]) => args);

// This route talks to subprocesses, never to the network — so the stub is a
// tripwire rather than a fixture. Anything that starts issuing requests from
// here fails loudly instead of reaching a real host from the test run.
const realFetch = globalThis.fetch;

beforeEach(() => {
  vi.resetModules();
  homedir.mockReturnValue("/Users/dev");
  readConfig.mockResolvedValue(CONFIG);
  stubLocal();
  globalThis.fetch = vi.fn(async () => {
    throw new Error("This route must not make network requests.");
  }) as unknown as typeof fetch;
});

afterEach(() => {
  tryCommand.mockReset();
  runCommand.mockReset();
  globalThis.fetch = realFetch;
});

describe("POST /api/terminal/kill — gates", () => {
  it("403s a cross-origin request, and runs nothing", async () => {
    const res = await callPOST(
      { repo: "Northwind/billing-app", prNumber: 42 },
      { origin: "http://evil.example.com", host: "localhost:3737" },
    );
    expect(res.status).toBe(403);
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("403s a DNS-rebinding request, where Origin and Host match but aren't local", async () => {
    const res = await callPOST(
      { repo: "Northwind/billing-app", prNumber: 42, removeWorktree: true, force: true },
      { origin: "http://evil.example:3737", host: "evil.example:3737" },
    );
    expect(res.status).toBe(403);
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("403s a request with no Origin at all", async () => {
    const res = await callPOST({ repo: "Northwind/billing-app", prNumber: 42 }, {
      host: "localhost:3737",
    });
    expect(res.status).toBe(403);
  });

  it("400s when terminals are disabled", async () => {
    readConfig.mockResolvedValue({ ...CONFIG, terminals: { enabled: false } });
    const res = await callPOST({ repo: "Northwind/billing-app", prNumber: 42 });
    expect(res.status).toBe(400);
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("400s a repo that isn't in config, and runs nothing", async () => {
    const res = await callPOST({ repo: "Evil/hax", prNumber: 42 });
    expect(res.status).toBe(400);
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("400s a bad PR number and a malformed body", async () => {
    expect(
      (await callPOST({ repo: "Northwind/billing-app", prNumber: "x" })).status,
    ).toBe(400);
    expect((await callPOST("not json{")).status).toBe(400);
    expect(runCommand).not.toHaveBeenCalled();
  });
});

describe("POST /api/terminal/kill — ending a session", () => {
  it("kills the derived session name, anchored", async () => {
    const body = await (
      await callPOST({ repo: "Northwind/billing-app", prNumber: 42 })
    ).json();
    expect(runCommand).toHaveBeenCalledWith("tmux", [
      "kill-session",
      "-t",
      `=${SESSION}`,
    ]);
    expect(body.killed).toBe(true);
  });

  it("kills the config-spelled session when the browser sends GitHub's casing", async () => {
    await callPOST({ repo: "NORTHWIND/Billing-App", prNumber: 42 });
    expect(runCommand).toHaveBeenCalledWith("tmux", ["kill-session", "-t", `=${SESSION}`]);
  });

  it("leaves the worktree alone unless removal was asked for", async () => {
    const body = await (
      await callPOST({ repo: "Northwind/billing-app", prNumber: 42 })
    ).json();
    expect(gitCalls()).toHaveLength(0);
    expect(body.removedWorktree ?? null).toBeNull();
  });

  it("reports an already-ended session as done", async () => {
    runCommand.mockImplementation(async (cmd: string) => {
      if (cmd === "tmux") throw new Error("can't find session: x");
      return "";
    });
    const body = await (
      await callPOST({ repo: "Northwind/billing-app", prNumber: 42 })
    ).json();
    expect(body.killed).toBe(true);
    expect(body.detail).toMatch(/already ended/i);
  });
});

describe("POST /api/terminal/kill — removing the worktree", () => {
  const REQUEST = {
    repo: "Northwind/billing-app",
    prNumber: 42,
    removeWorktree: true,
  };

  it("removes the managed worktree and prunes after it", async () => {
    const body = await (await callPOST(REQUEST)).json();
    expect(gitCalls()).toEqual([
      ["-C", REPO_PATH, "worktree", "remove", "--", MANAGED],
    ]);
    expect(body.removedWorktree).toBe(MANAGED);
    expect(
      tryCommand.mock.calls.some(
        ([cmd, args]) => cmd === "git" && (args as string[]).includes("prune"),
      ),
    ).toBe(true);
  });

  it("kills the session before touching the directory", async () => {
    await callPOST(REQUEST);
    // Removing a worktree out from under a shell sitting in it leaves tmux in a
    // directory that no longer exists.
    expect(
      runCommand.mock.calls
        .filter(([, args]) => !(args as string[]).includes("status"))
        .map(([cmd]) => cmd),
    ).toEqual(["tmux", "git"]);
  });

  it("waits for the session's ttys to clear before touching the directory", async () => {
    // Ordering alone isn't the invariant — `kill-session` returns before the
    // process inside is gone, so "tmux ran first" is true even with the wait
    // deleted. What has to hold is that the drain *looked, saw the pane's tty
    // still busy, and looked again* before git removed the directory out from
    // under it. So ps reports the tty occupied on the first poll and clear on
    // the second, and every command lands in one ordered log.
    const order: string[] = [];
    let psPolls = 0;
    tryCommand.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === "tmux" && args.includes("list-panes")) return "/dev/ttys009\n";
      if (cmd === "ps") {
        order.push(`ps:${++psPolls}`);
        return psPolls === 1
          ? "TTY      COMM\nttys009  claude"
          : "TTY      COMM\nttys001  zsh";
      }
      if (cmd === "git" && args.includes("worktree") && args.includes("list")) {
        return args[1] === REPO_PATH ? WORKTREES : "";
      }
      return "";
    });
    runCommand.mockImplementation(async (cmd: string, args: string[]) => {
      order.push(args.includes("kill-session") ? "kill" : args.includes("status") ? "status" : cmd);
      return "";
    });

    const body = await (await callPOST(REQUEST)).json();

    expect(order).toEqual(["kill", "ps:1", "ps:2", "status", "git"]);
    expect(body.removedWorktree).toBe(MANAGED);
  });

  it("refuses a dirty worktree, but still ends the session", async () => {
    stubLocal({ dirty: true });
    const body = await (await callPOST(REQUEST)).json();
    expect(body.killed).toBe(true);
    expect(body.removedWorktree).toBeNull();
    expect(body.blocked).toMatch(/uncommitted/i);
    expect(gitCalls()).toHaveLength(0);
  });

  it("refuses the removal when the clean check itself fails", async () => {
    // Fail closed: a `git status` that errors must not read as "clean".
    runCommand.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === "git" && args.includes("status")) throw new Error("index corrupt");
      return "";
    });
    const body = await (await callPOST(REQUEST)).json();
    expect(body.killed).toBe(true);
    expect(body.removedWorktree).toBeNull();
    expect(body.blocked).toMatch(/uncommitted/i);
    expect(gitCalls()).toHaveLength(0);
  });

  it("gives the removal far longer than an ordinary command", async () => {
    await callPOST(REQUEST);
    const remove = runCommand.mock.calls.find(([, args]) => (args as string[]).includes("remove"));
    expect(remove?.[2]).toBe(WORKTREE_REMOVE_TIMEOUT_MS);
    expect(WORKTREE_REMOVE_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000);
  });

  it("removes a dirty worktree when forced, with --force", async () => {
    stubLocal({ dirty: true });
    const body = await (await callPOST({ ...REQUEST, force: true })).json();
    expect(body.removedWorktree).toBe(MANAGED);
    expect(gitCalls()[0]).toContain("--force");
  });

  it("removes nothing for a PR whose worktree was merely reused", async () => {
    // PR 99 has no directory under worktreeRoot — its terminal reused a
    // checkout that already held the branch. Asking to remove one must be a
    // no-op rather than reaching for the reused directory.
    const body = await (await callPOST({ ...REQUEST, prNumber: 99 })).json();
    expect(body.killed).toBe(true);
    expect(body.removedWorktree).toBeNull();
    expect(gitCalls()).toHaveLength(0);
  });

  it("removes the worktree even when the session had already ended", async () => {
    // The worktree-only row: tmux has nothing, but the directory is the whole
    // reason for the request.
    runCommand.mockImplementation(async (cmd: string) => {
      if (cmd === "tmux") throw new Error("no server running");
      return "";
    });
    const body = await (await callPOST(REQUEST)).json();
    expect(body.killed).toBe(true);
    expect(body.removedWorktree).toBe(MANAGED);
  });

  it("ignores a worktree path supplied by the client", async () => {
    // The body carries identifiers only. The path removed is the one this
    // machine found for that PR, never one the page named.
    await callPOST({ ...REQUEST, worktreePath: "/etc", path: "/etc" });
    expect(gitCalls()[0]).toContain(MANAGED);
    expect(JSON.stringify(gitCalls())).not.toContain("/etc");
  });

  it("does nothing for a repo with no local clone", async () => {
    const body = await (
      await callPOST({ repo: "Northwind/no-clone", prNumber: 42, removeWorktree: true })
    ).json();
    expect(body.killed).toBe(true);
    expect(gitCalls()).toHaveLength(0);
  });
});
