import { describe, expect, it } from "vitest";
import {
  buildSessions,
  claudeProcesses,
  cleanTitle,
  focusErrorDetail,
  focusOutcome,
  isAllowedHost,
  isITermRunning,
  isSameOrigin,
  isValidTty,
  isWorking,
  normalizeTty,
  parseITermSessions,
  parseLsofCwds,
  parsePsOutput,
  shortenPath,
  sortSessions,
  summarizeSessions,
  workspaceName,
  type PsRow,
} from "./sessions";
import type { ClaudeSession } from "@/types";

/**
 * The fixtures below are real output, captured from a live macOS host — `ps`
 * reports a bare `ttys001` while iTerm2 reports `/dev/ttys001`, and Claude Code's
 * idle title is "✳ Claude Code" against a braille spinner frame when it is
 * mid-turn. Inventing these shapes is how the last upstream bug got through.
 */

const PS_REAL = `  PID TTY      COMM
 2952 ??       /Applications/Claude.app/Contents/MacOS/Claude
 3025 ??       /Applications/Claude.app/Contents/Frameworks/Claude Helper (Renderer).app/Contents/MacOS/Claude Helper (Renderer)
 2656 ttys001  -zsh
91181 ttys001  claude
57054 ttys009  claude
 5044 ttys001  /Users/alexdoe/.cache/gitstatus/gitstatusd-darwin-arm64`;

const LSOF_REAL = `p368
fcwd
n/
p91181
fcwd
n/Users/alexdoe/code/pitwall
p57054
fcwd
n/Users/alexdoe/code/billing-app`;

const ITERM_REAL = [
  "1\t1\t/dev/ttys001\t⠐ Add review requested section in GitHub (node)",
  "2\t1\t/dev/ttys009\t✳ Claude Code (node)",
  "2\t1\t/dev/ttys005\t../forms-app (-zsh)",
].join("\n");

describe("normalizeTty", () => {
  it("adds the device prefix ps omits", () => {
    expect(normalizeTty("ttys001")).toBe("/dev/ttys001");
  });

  it("leaves an already-qualified path alone", () => {
    expect(normalizeTty("/dev/ttys001")).toBe("/dev/ttys001");
  });

  it("treats ps's no-terminal markers as no tty", () => {
    expect(normalizeTty("??")).toBe("");
    expect(normalizeTty("?")).toBe("");
    expect(normalizeTty("  ")).toBe("");
  });
});

describe("isValidTty", () => {
  it("accepts a pty device path", () => {
    expect(isValidTty("/dev/ttys001")).toBe(true);
    expect(isValidTty("/dev/ttys0")).toBe(true);
  });

  it("rejects anything that isn't one", () => {
    expect(isValidTty("/etc/passwd")).toBe(false);
    expect(isValidTty("ttys001")).toBe(false);
    expect(isValidTty("/dev/ttys")).toBe(false);
    expect(isValidTty("/dev/ttys00001")).toBe(false);
    expect(isValidTty("/dev/../etc/passwd")).toBe(false);
  });

  it("rejects an AppleScript break-out attempt", () => {
    // The value reaches an osascript argument. This is the allow-list that makes
    // escaping unnecessary, so it has to refuse quoting and command syntax.
    expect(isValidTty('/dev/ttys001" & do shell script "touch /tmp/pwned')).toBe(false);
    expect(isValidTty("/dev/ttys001; touch /tmp/pwned")).toBe(false);
    expect(isValidTty("/dev/ttys001\n/dev/ttys002")).toBe(false);
  });

  it("rejects non-strings", () => {
    expect(isValidTty(undefined)).toBe(false);
    expect(isValidTty(null)).toBe(false);
    expect(isValidTty(1)).toBe(false);
    expect(isValidTty({})).toBe(false);
  });
});

describe("isAllowedHost", () => {
  it("accepts this machine by any of its local names, on any port", () => {
    for (const host of ["localhost:3737", "127.0.0.1:3737", "[::1]:3737", "LOCALHOST:3737", "localhost"]) {
      expect(isAllowedHost(host)).toBe(true);
    }
    expect(isAllowedHost("localhost:4000")).toBe(true);
  });

  it("refuses any other hostname, which is what DNS rebinding sends", () => {
    for (const host of [
      "evil.example:3737",
      "localhost.evil.example:3737",
      "127.0.0.1.nip.io:3737",
      "192.168.1.10:3737",
      "0.0.0.0:3737",
    ]) {
      expect(isAllowedHost(host)).toBe(false);
    }
  });

  it("refuses a missing or malformed Host", () => {
    expect(isAllowedHost(null)).toBe(false);
    expect(isAllowedHost("")).toBe(false);
    expect(isAllowedHost("local host:3737")).toBe(false);
  });

  it("refuses a Host that only parses as local, like userinfo or a path", () => {
    // `new URL` reads these as localhost; the whole value has to be local.
    for (const host of [
      "evil.example:3737@localhost:3737",
      "evil.example@localhost",
      "localhost:3737/evil",
      "localhost:3737#x",
      "localhost:",
      "localhost:123456",
    ]) {
      expect(isAllowedHost(host)).toBe(false);
    }
  });
});

describe("isSameOrigin", () => {
  it("accepts the dashboard's own origin", () => {
    expect(isSameOrigin("http://localhost:3737", "localhost:3737")).toBe(true);
  });

  it("rejects another site", () => {
    expect(isSameOrigin("https://evil.example", "localhost:3737")).toBe(false);
  });

  it("rejects a different port on the same host", () => {
    expect(isSameOrigin("http://localhost:3000", "localhost:3737")).toBe(false);
  });

  it("rejects a missing origin rather than trusting it", () => {
    // Browsers send Origin on every fetch POST, so its absence means the caller
    // is not the dashboard.
    expect(isSameOrigin(null, "localhost:3737")).toBe(false);
    expect(isSameOrigin("", "localhost:3737")).toBe(false);
  });

  it("rejects a rebinding request, where Origin and Host match but aren't local", () => {
    expect(isSameOrigin("http://evil.example:3737", "evil.example:3737")).toBe(false);
  });

  it("rejects a missing or unparseable host", () => {
    expect(isSameOrigin("http://localhost:3737", null)).toBe(false);
    expect(isSameOrigin("not a url", "localhost:3737")).toBe(false);
  });
});

describe("parsePsOutput", () => {
  it("skips the header row", () => {
    expect(parsePsOutput(PS_REAL).some((r) => r.command === "COMM")).toBe(false);
  });

  it("drops processes with no controlling terminal", () => {
    // This is what excludes every process of the Claude desktop app.
    const pids = parsePsOutput(PS_REAL).map((r) => r.pid);
    expect(pids).not.toContain(2952);
    expect(pids).not.toContain(3025);
  });

  it("normalises the tty and keeps the pid as a number", () => {
    const row = parsePsOutput(PS_REAL).find((r) => r.pid === 91181);
    expect(row).toEqual({ pid: 91181, tty: "/dev/ttys001", command: "claude" });
  });

  it("keeps a command containing spaces intact", () => {
    const out = " 123 ttys002  Claude Helper (Renderer)";
    expect(parsePsOutput(out)[0].command).toBe("Claude Helper (Renderer)");
  });

  it("returns nothing for empty output", () => {
    expect(parsePsOutput("")).toEqual([]);
  });
});

describe("claudeProcesses", () => {
  const row = (over: Partial<PsRow> = {}): PsRow => ({
    pid: 1,
    tty: "/dev/ttys001",
    command: "claude",
    ...over,
  });

  it("finds the Claude Code CLI", () => {
    expect(claudeProcesses([row()])).toHaveLength(1);
  });

  it("matches case-insensitively and ignores the launch path", () => {
    expect(
      claudeProcesses([row({ command: "/opt/homebrew/bin/Claude" })]),
    ).toHaveLength(1);
  });

  it("excludes the desktop app by path, not just by tty", () => {
    // Its executable is also called "Claude"; today only the missing tty
    // separates them, and one condition is too few.
    expect(
      claudeProcesses([
        row({ command: "/Applications/Claude.app/Contents/MacOS/Claude" }),
      ]),
    ).toEqual([]);
  });

  it("excludes unrelated processes", () => {
    expect(claudeProcesses([row({ command: "-zsh" }), row({ command: "node" })])).toEqual(
      [],
    );
  });

  it("does not match a command that merely contains claude", () => {
    expect(claudeProcesses([row({ command: "not-claude-really" })])).toEqual([]);
  });
});

describe("parseLsofCwds", () => {
  it("pairs each pid with its working directory", () => {
    const cwds = parseLsofCwds(LSOF_REAL);
    expect(cwds.get(91181)).toBe(
      "/Users/alexdoe/code/pitwall",
    );
    expect(cwds.get(57054)).toBe(
      "/Users/alexdoe/code/billing-app",
    );
  });

  it("keeps the first path for a pid rather than a later one", () => {
    const cwds = parseLsofCwds("p1\nfcwd\nn/first\nn/second");
    expect(cwds.get(1)).toBe("/first");
  });

  it("ignores a path with no pid before it", () => {
    expect(parseLsofCwds("n/orphan").size).toBe(0);
  });

  it("ignores a path that isn't the cwd descriptor's", () => {
    // Without the fcwd guard, a widened filter or an lsof emitting more fields
    // would report some unrelated open file as the working directory.
    expect(parseLsofCwds("p1\nn/not-cwd").size).toBe(0);
    expect(parseLsofCwds("p1\nftxt\nn/some/binary").size).toBe(0);
  });

  it("takes the cwd path when other descriptors surround it", () => {
    const cwds = parseLsofCwds("p1\nftxt\nn/some/binary\nfcwd\nn/real/cwd");
    expect(cwds.get(1)).toBe("/real/cwd");
  });

  it("does not carry the cwd descriptor across into the next process", () => {
    const cwds = parseLsofCwds("p1\nfcwd\nn/first\np2\nn/leaked");
    expect(cwds.get(1)).toBe("/first");
    expect(cwds.has(2)).toBe(false);
  });

  it("ignores an unparseable pid line", () => {
    expect(parseLsofCwds("pnotanumber\nfcwd\nn/x").size).toBe(0);
  });

  it("handles empty output", () => {
    expect(parseLsofCwds("").size).toBe(0);
  });
});

describe("parseITermSessions", () => {
  it("keys sessions by tty", () => {
    const sessions = parseITermSessions(ITERM_REAL);
    expect(sessions.get("/dev/ttys001")?.rawTitle).toBe(
      "⠐ Add review requested section in GitHub (node)",
    );
    expect(sessions.get("/dev/ttys009")?.rawTitle).toBe("✳ Claude Code (node)");
  });

  it("keeps the title raw so the spinner survives for isWorking", () => {
    // Cleaning here stripped the spinner before it could be detected, and every
    // session reported as not working.
    const raw = parseITermSessions(ITERM_REAL).get("/dev/ttys001")!.rawTitle;
    expect(isWorking(raw)).toBe(true);
  });

  it("keeps a title that itself contains a tab", () => {
    const sessions = parseITermSessions("1\t1\t/dev/ttys001\ta\tb");
    expect(sessions.get("/dev/ttys001")?.rawTitle).toBe("a\tb");
  });

  it("skips short and blank lines", () => {
    expect(parseITermSessions("1\t1\t/dev/ttys001\n\n  \n").size).toBe(0);
  });

  it("handles the empty string iTerm2 returns when it isn't running", () => {
    expect(parseITermSessions("").size).toBe(0);
  });
});

describe("isWorking", () => {
  it("is true for a braille spinner frame", () => {
    expect(isWorking("⠐ Add review requested section in GitHub")).toBe(true);
    expect(isWorking("⠂ something")).toBe(true);
  });

  it("is false for the idle title", () => {
    expect(isWorking("✳ Claude Code")).toBe(false);
  });

  it("is false for a title that only starts with whitespace", () => {
    // Guards a regex that once allowed \s to satisfy the spinner match.
    expect(isWorking("   Claude Code")).toBe(false);
  });

  it("is false for no title at all", () => {
    expect(isWorking("")).toBe(false);
  });
});

describe("cleanTitle", () => {
  it("strips the spinner and the job iTerm2 appends", () => {
    expect(cleanTitle("⠐ Add review requested section in GitHub (node)")).toBe(
      "Add review requested section in GitHub",
    );
  });

  it("empties Claude Code's idle placeholder", () => {
    // "Claude Code" on every idle row says nothing the panel heading doesn't.
    expect(cleanTitle("✳ Claude Code (node)")).toBe("");
    expect(cleanTitle("✳ Claude Code")).toBe("");
  });

  it("keeps a title with parentheses inside it", () => {
    expect(cleanTitle("Fix the (broken) thing (node)")).toBe("Fix the (broken) thing");
  });

  it("handles an untitled session", () => {
    expect(cleanTitle("")).toBe("");
  });
});

describe("workspaceName", () => {
  it("names the directory", () => {
    expect(workspaceName("/Users/k/code/github/pitwall")).toBe("pitwall");
  });

  it("keeps the worktree convention readable", () => {
    expect(workspaceName("/Users/alexdoe/code/forms-app@feature-x")).toBe(
      "forms-app@feature-x",
    );
  });

  it("ignores a trailing slash", () => {
    expect(workspaceName("/Users/k/code/pitwall/")).toBe("pitwall");
  });

  it("is empty when the cwd is unknown", () => {
    expect(workspaceName("")).toBe("");
  });
});

describe("shortenPath", () => {
  const home = "/Users/alexdoe";

  it("collapses the home directory", () => {
    expect(shortenPath(`${home}/code/pitwall`, home)).toBe("~/code/pitwall");
  });

  it("collapses home itself", () => {
    expect(shortenPath(home, home)).toBe("~");
  });

  it("leaves a path outside home alone", () => {
    expect(shortenPath("/opt/thing", home)).toBe("/opt/thing");
  });

  it("does not collapse a sibling directory that merely shares the prefix", () => {
    expect(shortenPath("/Users/alexdoe2/x", home)).toBe("/Users/alexdoe2/x");
  });

  it("is a no-op with no home to compare against", () => {
    expect(shortenPath("/Users/k/x", "")).toBe("/Users/k/x");
  });
});

describe("buildSessions", () => {
  const processes: PsRow[] = [
    { pid: 91181, tty: "/dev/ttys001", command: "claude" },
    { pid: 57054, tty: "/dev/ttys009", command: "claude" },
  ];
  const cwds = parseLsofCwds(LSOF_REAL);
  const iterm = parseITermSessions(ITERM_REAL);
  const home = "/Users/alexdoe";

  it("joins process, directory and terminal into one row", () => {
    const [first] = buildSessions(processes, cwds, iterm, home);
    expect(first).toEqual({
      pid: 91181,
      tty: "/dev/ttys001",
      cwd: "/Users/alexdoe/code/pitwall",
      path: "~/code/pitwall",
      workspace: "pitwall",
      title: "Add review requested section in GitHub",
      isWorking: true,
      canFocus: true,
    });
  });

  it("derives working from the raw title, not the cleaned one", () => {
    const working = buildSessions(processes, cwds, iterm, home).filter((s) => s.isWorking);
    expect(working.map((s) => s.workspace)).toEqual(["pitwall"]);
  });

  it("marks a session with no iTerm2 window unfocusable instead of hiding it", () => {
    // It may be in tmux or another terminal. Offering a click that could only
    // fail is worse than saying so.
    const orphan: PsRow = { pid: 999, tty: "/dev/ttys099", command: "claude" };
    const [row] = buildSessions([orphan], cwds, iterm, home);
    expect(row).toMatchObject({ canFocus: false, title: "", isWorking: false });
  });

  it("survives a working directory lsof could not read", () => {
    const row = buildSessions(
      [{ pid: 12345, tty: "/dev/ttys001", command: "claude" }],
      new Map(),
      iterm,
      home,
    )[0];
    expect(row).toMatchObject({ cwd: "", path: "", workspace: "" });
  });

  it("returns nothing when no Claude process is running", () => {
    expect(buildSessions([], cwds, iterm, home)).toEqual([]);
  });
});

describe("sortSessions", () => {
  const s = (over: Partial<ClaudeSession>): ClaudeSession =>
    ({ pid: 1, workspace: "a", isWorking: false, ...over }) as ClaudeSession;

  it("puts working sessions first", () => {
    const sorted = sortSessions([
      s({ workspace: "aaa", isWorking: false }),
      s({ workspace: "zzz", isWorking: true }),
    ]);
    expect(sorted.map((x) => x.workspace)).toEqual(["zzz", "aaa"]);
  });

  it("orders the rest by workspace so rows don't reshuffle on refresh", () => {
    const sorted = sortSessions([
      s({ workspace: "pitwall" }),
      s({ workspace: "billing-app" }),
      s({ workspace: "forms-app" }),
    ]);
    expect(sorted.map((x) => x.workspace)).toEqual([
      "billing-app",
      "forms-app",
      "pitwall",
    ]);
  });

  it("breaks a workspace tie by pid rather than leaving it unstable", () => {
    const sorted = sortSessions([
      s({ workspace: "same", pid: 20 }),
      s({ workspace: "same", pid: 10 }),
    ]);
    expect(sorted.map((x) => x.pid)).toEqual([10, 20]);
  });

  it("does not mutate its input", () => {
    const input = [s({ workspace: "z" }), s({ workspace: "a" })];
    sortSessions(input);
    expect(input.map((x) => x.workspace)).toEqual(["z", "a"]);
  });
});

describe("focusOutcome", () => {
  it("reports success", () => {
    expect(focusOutcome("focused\n")).toEqual({
      focused: true,
      detail: "Brought to the front.",
    });
  });

  it("explains a terminal that has since closed", () => {
    expect(focusOutcome("not-found")).toMatchObject({ focused: false });
    expect(focusOutcome("not-found").detail).toMatch(/no longer open/i);
  });

  it("distinguishes iTerm2 not running", () => {
    expect(focusOutcome("not-running").detail).toMatch(/isn't running/i);
  });

  it("treats anything unexpected as a closed terminal rather than success", () => {
    expect(focusOutcome("").focused).toBe(false);
    expect(focusOutcome("something else").focused).toBe(false);
  });
});

describe("focusErrorDetail", () => {
  it("turns a macOS Automation refusal into the action that fixes it", () => {
    expect(focusErrorDetail("Not authorized to send Apple events to iTerm2.")).toMatch(
      /System Settings/,
    );
    expect(focusErrorDetail("execution error: ... (-1743)")).toMatch(/Automation/);
  });

  it("passes anything else through unchanged", () => {
    expect(focusErrorDetail("osascript: command not found")).toBe(
      "osascript: command not found",
    );
  });
});

describe("summarizeSessions", () => {
  const s = (isWorking = false): ClaudeSession => ({ isWorking }) as ClaudeSession;

  it("says so when nothing is running", () => {
    expect(summarizeSessions([])).toBe("no sessions running");
  });

  it("counts one session in the singular", () => {
    expect(summarizeSessions([s()])).toBe("1 session");
  });

  it("counts several", () => {
    expect(summarizeSessions([s(), s(), s()])).toBe("3 sessions");
  });

  it("names how many are mid-turn", () => {
    expect(summarizeSessions([s(true), s(), s(true)])).toBe("3 sessions · 2 working");
  });
});

describe("parseITermSessions + parsePsOutput together", () => {
  it("joins ps's bare tty to iTerm2's device path", () => {
    // The two commands spell the same terminal differently; this is the join that
    // the whole panel depends on.
    const proc = claudeProcesses(parsePsOutput(PS_REAL)).find((p) => p.pid === 91181)!;
    const iterm = parseITermSessions(ITERM_REAL);
    expect(iterm.has(proc.tty)).toBe(true);
  });
});

describe("isITermRunning", () => {
  it("finds iTerm2 by its bundle path, though it has no terminal of its own", () => {
    const ps = `  PID TTY      COMM
  700 ??       /Applications/iTerm.app/Contents/MacOS/iTerm2
  701 ??       /Applications/iTerm.app/Contents/XPCServices/pidinfo.xpc/Contents/MacOS/pidinfo`;
    expect(isITermRunning(ps)).toBe(true);
  });

  it("isn't fooled by iTerm2's helper processes alone", () => {
    const ps = `  PID TTY      COMM
  701 ??       /Applications/iTerm.app/Contents/XPCServices/pidinfo.xpc/Contents/MacOS/pidinfo
  702 ??       /Users/a/Library/Application Support/iTerm2/iTermServer-3.7.2`;
    expect(isITermRunning(ps)).toBe(false);
  });
});
