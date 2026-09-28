import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LIST_ITERM_SESSIONS } from "@/lib/osascript";

/**
 * Route-level tests for the sessions panel. These cover the wiring the pure lib
 * tests can't: which commands get run, which get skipped, and how a host that
 * can't answer is reported. `@/lib/exec` is replaced rather than
 * `node:child_process` — see the note in that module for why.
 */

const tryCommand = vi.hoisted(() => vi.fn());
vi.mock("@/lib/exec", () => ({ tryCommand, runCommand: vi.fn() }));

// Mocked because it reads the filesystem — without this the route picks up
// whoever's real config.json is on the machine, so whether the tmux half runs
// depends on the developer's own settings rather than on the test.
const readConfig = vi.hoisted(() => vi.fn());
vi.mock("@/lib/config", () => ({ readConfig }));

const BASE_CONFIG = {
  repos: [{ owner: "Northwind", name: "forms-app" }],
  linear: { teamKey: "ENG" },
  refreshIntervalSeconds: 60,
};

/** Terminals off unless a test turns them on — the shipped default. */
function setConfig(overrides: Record<string, unknown> = {}) {
  readConfig.mockResolvedValue({ ...BASE_CONFIG, ...overrides });
}

const platform = vi.hoisted(() => vi.fn(() => "darwin"));
const homedir = vi.hoisted(() => vi.fn(() => "/Users/alexdoe"));
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  platform,
  homedir,
}));

const PS = `  PID TTY      COMM
 2952 ??       /Applications/Claude.app/Contents/MacOS/Claude
91181 ttys001  claude
57054 ttys009  claude`;

const LSOF = `p91181
fcwd
n/Users/alexdoe/code/pitwall
p57054
fcwd
n/Users/alexdoe/code/billing-app`;

const ITERM = [
  "1\t1\t/dev/ttys001\t⠐ Wire up the panel (node)",
  "2\t1\t/dev/ttys009\t✳ Claude Code (node)",
].join("\n");

/** Answers each command by name, so argument order can't silently swap them. */
function stubCommands(byCommand: Record<string, string>) {
  tryCommand.mockImplementation(async (cmd: string) => byCommand[cmd] ?? "");
}

async function callGET() {
  const { GET } = await import("@/app/api/sessions/route");
  return GET();
}

beforeEach(() => {
  vi.resetModules();
  platform.mockReturnValue("darwin");
  homedir.mockReturnValue("/Users/alexdoe");
  stubCommands({ ps: PS, lsof: LSOF, osascript: ITERM });
  setConfig();
});

afterEach(() => {
  tryCommand.mockReset();
  readConfig.mockReset();
});

describe("GET /api/sessions", () => {
  it("returns a row per Claude Code session, working first", async () => {
    const res = await callGET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sessions).toHaveLength(2);
    expect(body.sessions[0]).toMatchObject({
      pid: 91181,
      tty: "/dev/ttys001",
      workspace: "pitwall",
      title: "Wire up the panel",
      isWorking: true,
      canFocus: true,
    });
    expect(body.sessions[1]).toMatchObject({
      workspace: "billing-app",
      isWorking: false,
      canFocus: true,
    });
  });

  it("collapses the home directory in the displayed path", async () => {
    const body = await (await callGET()).json();
    expect(body.sessions[0].path).toBe("~/code/pitwall");
  });

  it("says nothing is unavailable when sessions can be focused", async () => {
    const body = await (await callGET()).json();
    expect(body.unavailable).toBeUndefined();
  });

  it("explains itself on a host that isn't macOS", async () => {
    // An empty list here would read as "no sessions running", which is a
    // different statement from "this can't be detected".
    platform.mockReturnValue("linux");
    const body = await (await callGET()).json();
    expect(body.sessions).toEqual([]);
    expect(body.unavailable).toContain("macOS only");
    expect(body.unavailable).toContain("linux");
  });

  it("runs no commands at all on a host that isn't macOS", async () => {
    platform.mockReturnValue("linux");
    await callGET();
    expect(tryCommand).not.toHaveBeenCalled();
  });

  it("skips the slow commands when no Claude process is running", async () => {
    stubCommands({ ps: "  PID TTY      COMM\n 2656 ttys001  -zsh" });
    const body = await (await callGET()).json();
    expect(body.sessions).toEqual([]);
    expect(tryCommand.mock.calls).toEqual([["ps", ["-eo", "pid,tty,comm"]]]);
  });

  it("asks ps for exactly the columns the parser expects", async () => {
    // The stub answers by command name, so a changed format string would
    // otherwise still be fed output that happens to match the old one.
    await callGET();
    expect(tryCommand).toHaveBeenCalledWith("ps", ["-eo", "pid,tty,comm"]);
  });

  it("asks lsof for cwd in the field format the parser expects", async () => {
    // -Fpn is what produces the p/f/n grouping; dropping it yields human output
    // that parses to nothing, and every row would silently lose its directory.
    await callGET();
    expect(tryCommand).toHaveBeenCalledWith("lsof", ["-d", "cwd", "-Fpn"]);
  });

  it("sends the iTerm2 script that refuses to launch iTerm2", async () => {
    // LIST_ITERM_SESSIONS carries the `is running` guard. Without it, a bare
    // `tell application "iTerm2"` starts a terminal — so a dashboard sitting
    // there polling would open one for you. Pin the exact constant.
    await callGET();
    expect(tryCommand).toHaveBeenCalledWith("osascript", ["-e", LIST_ITERM_SESSIONS]);
    expect(LIST_ITERM_SESSIONS).toContain('if not (application "iTerm2" is running)');
  });

  it("flags a likely Automation refusal when iTerm2 is running but shows no windows", async () => {
    // osascript returns empty rather than erroring when macOS refuses it, so an
    // unexplained empty panel is the symptom to name.
    const withITerm = `${PS}\n  700 ??       /Applications/iTerm.app/Contents/MacOS/iTerm2`;
    stubCommands({ ps: withITerm, lsof: LSOF, osascript: "" });
    const body = await (await callGET()).json();
    expect(body.sessions).toHaveLength(2);
    expect(body.sessions.every((s: { canFocus: boolean }) => !s.canFocus)).toBe(true);
    expect(body.unavailable).toMatch(/Automation access/);
  });

  it("says iTerm2 isn't running rather than blaming permissions", async () => {
    // Someone on Terminal.app or Ghostty: the sessions are real, iTerm2 just
    // isn't there to focus them.
    stubCommands({ ps: PS, lsof: LSOF, osascript: "" });
    const body = await (await callGET()).json();
    expect(body.sessions).toHaveLength(2);
    expect(body.unavailable).toMatch(/iTerm2 isn't running/);
    expect(body.unavailable).not.toMatch(/Automation/);
  });

  it("still lists sessions when lsof reveals no directories", async () => {
    stubCommands({ ps: PS, lsof: "", osascript: ITERM });
    const body = await (await callGET()).json();
    expect(body.sessions).toHaveLength(2);
    expect(body.sessions.map((s: { workspace: string }) => s.workspace)).toEqual(["", ""]);
  });

  it("returns an empty list when ps itself produces nothing", async () => {
    stubCommands({});
    const body = await (await callGET()).json();
    expect(body.sessions).toEqual([]);
  });

  it("500s rather than throwing when something unexpected fails", async () => {
    tryCommand.mockRejectedValue(new Error("boom"));
    const res = await callGET();
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("boom");
  });
});

describe("GET /api/sessions — hosted terminals", () => {
  const TERMINALS = { enabled: true };
  // ttys009 is the one Pitwall owns; ttys001 is a terminal the user opened.
  const TMUX_SESSIONS = "pitwall_Northwind-forms-app_3801|1786025940|0";
  const TMUX_PANES =
    "pitwall_Northwind-forms-app_3801|/dev/ttys009|/Users/dev/Dev/forms-app";

  function withTmux(extra: Record<string, string> = {}) {
    setConfig({ terminals: TERMINALS });
    tryCommand.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === "tmux") {
        return args[0] === "list-sessions" ? TMUX_SESSIONS : TMUX_PANES;
      }
      return ({ ps: PS, lsof: LSOF, osascript: ITERM, ...extra })[cmd] ?? "";
    });
  }

  it("expands a ~ localPath before asking git for worktrees, and marks a dirty one", async () => {
    // git -C gets no shell, so an unexpanded tilde fails silently: every repo
    // reports no worktrees and the panel says there is nothing to remove. That
    // shipped once, and no route test here had a localPath to catch it.
    const managed = "/Users/alexdoe/.pitwall/worktrees/Northwind-forms-app/pr-3801-feature";
    setConfig({
      terminals: TERMINALS,
      repos: [{ owner: "Northwind", name: "forms-app", localPath: "~/Dev/forms-app" }],
    });
    tryCommand.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === "tmux") return args[0] === "list-sessions" ? TMUX_SESSIONS : TMUX_PANES;
      if (cmd === "git" && args.includes("list")) {
        return args[1] === "/Users/alexdoe/Dev/forms-app"
          ? `worktree /Users/alexdoe/Dev/forms-app\nbranch refs/heads/main\n\nworktree ${managed}\nbranch refs/heads/feature\n`
          : "";
      }
      if (cmd === "git" && args.includes("status")) return args[1] === managed ? " M a.ts\n" : "";
      return ({ ps: PS, lsof: LSOF, osascript: ITERM })[cmd] ?? "";
    });
    const body = await (await callGET()).json();
    expect(tryCommand).toHaveBeenCalledWith("git", [
      "-C",
      "/Users/alexdoe/Dev/forms-app",
      "worktree",
      "list",
      "--porcelain",
    ]);
    expect(body.worktrees).toEqual([
      expect.objectContaining({ path: managed, prNumber: 3801, dirty: true }),
    ]);
  });

  it("runs no tmux commands when terminals are disabled", async () => {
    await callGET();
    expect(tryCommand).not.toHaveBeenCalledWith("tmux", expect.anything());
  });

  it("reports an empty terminals list when they're disabled", async () => {
    // Not omitted: the field is always present so the client never has to guess
    // whether an absent key means "off" or "an older server".
    const body = await (await callGET()).json();
    expect(body.terminals).toEqual([]);
  });

  it("lists a hosted terminal resolved back to its repo and PR", async () => {
    withTmux();
    const body = await (await callGET()).json();
    expect(body.terminals).toEqual([
      {
        sessionName: "pitwall_Northwind-forms-app_3801",
        repo: "Northwind/forms-app",
        prNumber: 3801,
        createdAt: new Date(1786025940 * 1000).toISOString(),
        attached: false,
        // Reported so a row can say the session reused an existing checkout
        // rather than getting a worktree of its own.
        cwd: "/Users/dev/Dev/forms-app",
      },
    ]);
  });

  it("drops a hosted terminal's tty from the discovered list", async () => {
    // The whole point of the split: without this, ttys009 appears twice — once
    // where it can be ended, and once as a row that can only refuse to focus.
    withTmux();
    const body = await (await callGET()).json();
    expect(body.sessions.map((s: { tty: string }) => s.tty)).toEqual([
      "/dev/ttys001",
    ]);
  });

  it("ignores a tmux session whose repo has left config.json", async () => {
    // The name is matched forwards against configured repos, so an unknown one
    // can't be half-resolved into a row offering actions it can't perform.
    setConfig({ terminals: TERMINALS, repos: [] });
    tryCommand.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === "tmux") {
        return args[0] === "list-sessions" ? TMUX_SESSIONS : TMUX_PANES;
      }
      return ({ ps: PS, lsof: LSOF, osascript: ITERM })[cmd] ?? "";
    });
    const body = await (await callGET()).json();
    expect(body.terminals).toEqual([]);
    // And its tty stays in the discovered list, since nothing claimed it.
    expect(body.sessions).toHaveLength(2);
  });

  it("still lists hosted terminals when no Claude process is running", async () => {
    // A session whose Claude has exited has no process to find, and is exactly
    // the one you need listed so it can be cleaned up.
    setConfig({ terminals: TERMINALS });
    tryCommand.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === "tmux") {
        return args[0] === "list-sessions" ? TMUX_SESSIONS : TMUX_PANES;
      }
      if (cmd === "ps") return "  PID TTY      COMM\n 2656 ttys001  -zsh";
      return "";
    });
    const body = await (await callGET()).json();
    expect(body.sessions).toEqual([]);
    expect(body.terminals).toHaveLength(1);
  });

  it("survives tmux being absent", async () => {
    // tryCommand yields "" on failure, which must parse to no terminals rather
    // than blanking the discovered half too.
    setConfig({ terminals: TERMINALS });
    stubCommands({ ps: PS, lsof: LSOF, osascript: ITERM });
    const body = await (await callGET()).json();
    expect(body.terminals).toEqual([]);
    expect(body.sessions).toHaveLength(2);
  });
});
