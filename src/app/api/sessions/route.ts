import { homedir, platform } from "node:os";
import path from "node:path";
import { NextResponse } from "next/server";
import { readConfig } from "@/lib/config";
import { tryCommand } from "@/lib/exec";
import { LIST_ITERM_SESSIONS } from "@/lib/osascript";
import {
  buildSessions,
  claudeProcesses,
  parseITermSessions,
  parseLsofCwds,
  parsePsOutput,
  isITermRunning,
  unfocusableReason,
} from "@/lib/sessions";
import {
  DEFAULT_WORKTREE_ROOT,
  TMUX_LIST_PANES_FORMAT,
  TMUX_LIST_SESSIONS_FORMAT,
  expandHome,
  normalizeTty,
  parseTmuxPaneCwds,
  parseTmuxPaneTtys,
  parseTmuxSessions,
  parseWorktreeList,
  pitwallOwnedTtys,
  pitwallTerminalSessions,
  terminalsEnabled,
} from "@/lib/terminal";
import { collectManagedWorktrees } from "@/lib/terminalWorktrees";
import type {
  AppConfig,
  PitwallTerminalSession,
  PitwallWorktree,
  SessionsResponse,
} from "@/types";

export const dynamic = "force-dynamic";

/**
 * The worktrees Pitwall created, with whether each has uncommitted changes.
 *
 * Found from git rather than from tmux, because the two outlive each other: a
 * session can be ended and leave its directory, and that directory would
 * otherwise be invisible to the panel — which is how leftovers pile up.
 *
 * `localPath` is expanded first. It is written by hand and conventionally starts
 * with `~`, and `git -C` gets no shell — an unexpanded tilde finds no worktrees
 * at all, silently, because these run through `tryCommand`.
 */
async function managedWorktrees(config: AppConfig): Promise<PitwallWorktree[]> {
  const home = homedir();
  const repos = config.repos.filter(
    (r): r is typeof r & { localPath: string } =>
      typeof r.localPath === "string" && r.localPath !== "",
  );

  const worktrees = await Promise.all(
    repos.map(async (repo) => ({
      repo,
      entries: parseWorktreeList(
        await tryCommand("git", [
          "-C",
          path.resolve(expandHome(repo.localPath, home)),
          "worktree",
          "list",
          "--porcelain",
        ]),
      ),
    })),
  );

  const found = collectManagedWorktrees({
    worktrees,
    worktreeRoot: config.terminals?.worktreeRoot ?? DEFAULT_WORKTREE_ROOT,
    home,
  });

  // Only the managed ones are worth a `git status`; running it over every
  // worktree in every clone would be far more subprocesses, nearly all of them
  // about directories this app will never touch.
  const dirty = await Promise.all(
    found.map(async (w) => (await tryCommand("git", ["-C", w.path, "status", "--porcelain"])).trim() !== ""),
  );
  return found.map((w, i) => ({ ...w, dirty: dirty[i] }));
}

/**
 * The terminals Pitwall is hosting, read from tmux rather than from the process
 * scan — a session whose Claude has exited still needs listing, so it can be
 * cleaned up rather than lingering invisibly.
 *
 * Returns the sessions and the ttys they occupy; the caller subtracts those from
 * what it discovered so nothing is listed twice.
 */
async function hostedTerminals(): Promise<{
  terminals: PitwallTerminalSession[];
  worktrees: PitwallWorktree[];
  ownedTtys: Set<string>;
}> {
  const empty = {
    terminals: [],
    worktrees: [],
    ownedTtys: new Set<string>(),
  };
  try {
    const config = await readConfig();
    if (!terminalsEnabled(config)) return empty;

    const [sessionsRaw, panesRaw, worktrees] = await Promise.all([
      tryCommand("tmux", ["list-sessions", "-F", TMUX_LIST_SESSIONS_FORMAT]),
      tryCommand("tmux", ["list-panes", "-a", "-F", TMUX_LIST_PANES_FORMAT]),
      managedWorktrees(config),
    ]);

    const terminals = pitwallTerminalSessions({
      rows: parseTmuxSessions(sessionsRaw),
      config,
      cwds: parseTmuxPaneCwds(panesRaw),
    });
    return {
      terminals,
      worktrees,
      ownedTtys: pitwallOwnedTtys({
        paneTtys: parseTmuxPaneTtys(panesRaw),
        sessions: terminals,
      }),
    };
  } catch {
    // tmux absent, or config unreadable. The discovered half still works, and a
    // broken terminals list shouldn't take the whole panel down with it.
    return empty;
  }
}

export async function GET() {
  try {
    // Reading other processes' state only makes sense on the machine you are
    // sitting at, and the focus half is iTerm2 on macOS. Say so rather than
    // returning an empty list, which would read as "no sessions running".
    if (platform() !== "darwin") {
      const response: SessionsResponse = {
        sessions: [],
        terminals: [],
        worktrees: [],
        unavailable: `Terminal sessions are detected on macOS only (this host is ${platform()}).`,
      };
      return NextResponse.json(response);
    }

    const [psOut, hosted] = await Promise.all([
      tryCommand("ps", ["-eo", "pid,tty,comm"]),
      hostedTerminals(),
    ]);
    const processes = claudeProcesses(parsePsOutput(psOut));

    // Nothing to join against, so the two slower commands are never run. The
    // hosted list still stands on its own — a tmux session whose Claude has
    // exited has no process to find.
    if (processes.length === 0) {
      return NextResponse.json({
        sessions: [],
        terminals: hosted.terminals,
        worktrees: hosted.worktrees,
      } satisfies SessionsResponse);
    }

    const [lsof, iterm] = await Promise.all([
      tryCommand("lsof", ["-d", "cwd", "-Fpn"]),
      tryCommand("osascript", ["-e", LIST_ITERM_SESSIONS]),
    ]);

    // Terminals this app started are listed under the half that can act on them,
    // so they are dropped here rather than appearing again as rows whose only
    // possible outcome is a refused focus.
    const sessions = buildSessions(
      processes,
      parseLsofCwds(lsof),
      parseITermSessions(iterm),
      homedir(),
    ).filter((s) => !hosted.ownedTtys.has(normalizeTty(s.tty)));

    // Sessions exist but none can be focused. On macOS that is almost always the
    // Automation permission, because osascript returns nothing rather than
    // erroring when it's refused — so an unexplained empty list is the symptom.
    const noneFocusable = sessions.length > 0 && sessions.every((s) => !s.canFocus);

    const response: SessionsResponse = {
      sessions,
      terminals: hosted.terminals,
      worktrees: hosted.worktrees,
      ...(noneFocusable
        ? { unavailable: unfocusableReason(isITermRunning(psOut)) }
        : {}),
    };
    return NextResponse.json(response);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
