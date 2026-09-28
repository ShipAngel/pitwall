import { homedir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { NextResponse } from "next/server";
import { readConfig } from "@/lib/config";
import { runCommand, tryCommand } from "@/lib/exec";
import { findConfiguredRepo, repoId } from "@/lib/repos";
import { isSameOrigin } from "@/lib/sessions";
import { KILL_DRAIN_TIMEOUT_MS, WORKTREE_REMOVE_TIMEOUT_MS } from "@/lib/timeouts";
import {
  DEFAULT_WORKTREE_ROOT,
  anyTtyOccupied,
  expandHome,
  isValidPRNumber,
  parseWorktreeList,
  parseSessionTtys,
  terminalsEnabled,
  tmuxKillSessionArgv,
  tmuxListSessionTtysArgv,
  tmuxSessionName,
} from "@/lib/terminal";
import {
  collectManagedWorktrees,
  findManagedWorktree,
  planWorktreeRemoval,
  worktreeRemoveArgv,
} from "@/lib/terminalWorktrees";
import type { KillTerminalResponse } from "@/types";

export const dynamic = "force-dynamic";

const DRAIN_POLL_MS = 100;

/**
 * Waits for a killed session's ttys to empty.
 *
 * Without this the response returns while the process is still being torn down,
 * the client refetches, and tmux — which has already forgotten the session —
 * no longer claims the tty. The dying process then appears in the *discovered*
 * list as a "no window" row: the killed terminal seems to jump from one list to
 * the other. Waiting means the refetch sees the state the user asked for.
 *
 * Best-effort. If it times out the session is still gone, so the caller reports
 * success either way — this only decides whether the answer is tidy.
 */
async function waitForTtysToClear(ttys: readonly string[]): Promise<void> {
  if (ttys.length === 0) return;
  // Bounded so a process that refuses to die can't hold the request open.
  const deadline = Date.now() + KILL_DRAIN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!anyTtyOccupied(await tryCommand("ps", ["-eo", "tty,comm"]), ttys)) return;
    await sleep(DRAIN_POLL_MS);
  }
}

/**
 * Removes the worktree Pitwall created for a PR, if that is what was asked for
 * and the directory allows it.
 *
 * The path is resolved here, from this machine's own `git worktree list`, and
 * checked with `isManagedWorktree` — a directory only qualifies if it sits
 * immediately under `<worktreeRoot>/<owner-name>/`. So a checkout that was
 * merely reused (your main clone, or one you made by hand) has no managed
 * worktree for this PR and nothing happens, no matter what the request said.
 *
 * The branch is never touched. Removing a worktree leaves refs alone, which is
 * what keeps the whole action recoverable: worst case you re-open the terminal
 * and get a fresh checkout.
 */
async function removeWorktreeFor(args: {
  repo: string;
  prNumber: number;
  removeWorktree: boolean;
  force: boolean;
}): Promise<{ removedWorktree: string | null; blocked: string | null }> {
  const { repo, prNumber, removeWorktree, force } = args;
  if (!removeWorktree) return { removedWorktree: null, blocked: null };

  const config = await readConfig();
  const repoConfig = findConfiguredRepo(config, repo);
  if (!repoConfig?.localPath) return { removedWorktree: null, blocked: null };

  const home = homedir();
  const repoPath = path.resolve(expandHome(repoConfig.localPath, home));

  const managed = collectManagedWorktrees({
    worktrees: [
      {
        repo: repoConfig,
        entries: parseWorktreeList(
          await tryCommand("git", ["-C", repoPath, "worktree", "list", "--porcelain"]),
        ),
      },
    ],
    worktreeRoot: config.terminals?.worktreeRoot ?? DEFAULT_WORKTREE_ROOT,
    home,
  });

  const worktree = findManagedWorktree(managed, repo, prNumber);
  if (worktree) {
    // Fails closed: a status check that errors (a corrupt index, a timeout) is
    // treated as dirty, so the removal is blocked rather than trusted to be
    // safe. The user can still choose "Delete anyway".
    try {
      worktree.dirty =
        (await runCommand("git", ["-C", worktree.path, "status", "--porcelain"])).trim() !== "";
    } catch {
      worktree.dirty = true;
    }
  }

  const plan = planWorktreeRemoval({ worktree, force });
  if (!plan.path) return { removedWorktree: null, blocked: plan.blocked };

  await runCommand(
    "git",
    ["-C", repoPath, ...worktreeRemoveArgv(plan.path, force)],
    WORKTREE_REMOVE_TIMEOUT_MS,
  );
  // Drops the administrative record too, so the same PR can be opened again
  // into the same path.
  await tryCommand("git", ["-C", repoPath, "worktree", "prune"]);
  return { removedWorktree: plan.path, blocked: null };
}

function refuse(detail: string, status: number) {
  return NextResponse.json({ killed: false, detail } satisfies KillTerminalResponse, {
    status,
  });
}

/**
 * Ends one per-PR tmux session, and with it the Claude Code running inside.
 *
 * The first thing in this app that destroys something rather than reading it.
 * Detaching a pane already exists in the dock and is free — the session survives
 * — so this endpoint is only for the case where you want it *gone*. It is
 * irreversible: whatever that Claude session had in context is lost. The
 * worktree on disk is deliberately left alone; removing it is a separate
 * decision with a larger blast radius, and it may hold uncommitted work.
 *
 * Four gates, matching /api/sessions/focus and adding one:
 *
 *  1. **POST only.** A GET is reachable from any page's `<img>` or a prefetch,
 *     and Pitwall runs on a predictable localhost port.
 *  2. **Same-origin.** Refuses anything not sent by the dashboard itself.
 *  3. **Terminals enabled.** If the feature is off, it has nothing to end.
 *  4. **Identifiers only.** The body carries `{repo, prNumber}`; the session name
 *     is derived here from config via `tmuxSessionName`. The browser cannot name
 *     a session, so it cannot reach one Pitwall didn't create — the same
 *     boundary the socket sidecar enforces.
 */
export async function POST(request: Request) {
  try {
    if (
      !isSameOrigin(request.headers.get("origin"), request.headers.get("host"))
    ) {
      return refuse("Cross-origin requests are refused.", 403);
    }

    const config = await readConfig();
    if (!terminalsEnabled(config)) {
      return refuse("Terminals are disabled in config.json.", 400);
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return refuse("Expected a JSON body.", 400);
    }

    const { repo: rawRepo, prNumber } = (body ?? {}) as {
      repo?: unknown;
      prNumber?: unknown;
    };
    if (typeof rawRepo !== "string" || !isValidPRNumber(prNumber)) {
      return refuse("Expected { repo, prNumber }.", 400);
    }

    // Not merely validation: a repo absent from config has no session name this
    // route will build, so there is nothing for a crafted body to reach.
    const repoConfig = findConfiguredRepo(config, rawRepo);
    if (!repoConfig) {
      return refuse(`Repo is not in config.json: ${rawRepo}`, 400);
    }
    // The config's spelling from here on, so the session name matches the one
    // the terminal was opened under whatever casing the browser sent.
    const repo = repoId(repoConfig);

    // Optional, and off unless asked for: ending a session is reversible in the
    // sense that you can open another, but a directory is not.
    const removeWorktree = (body as { removeWorktree?: unknown }).removeWorktree === true;
    const force = (body as { force?: unknown }).force === true;

    const sessionName = tmuxSessionName(repo, prNumber);

    // Read before killing: once tmux has forgotten the session there is nothing
    // left to ask which ttys it held.
    const ttys = parseSessionTtys(
      await tryCommand("tmux", tmuxListSessionTtysArgv(sessionName)),
    );

    try {
      await runCommand("tmux", tmuxKillSessionArgv(sessionName));
    } catch (err) {
      // tmux exits non-zero when the session is already gone, which is the
      // outcome the caller wanted — report it as done rather than as a failure.
      const msg = err instanceof Error ? err.message : String(err);
      if (/can't find session|no server running/i.test(msg)) {
        // Already gone is the outcome the caller wanted — but the worktree may
        // still be there, and is often the whole reason for the request when a
        // session ended on its own.
        const tidied = await removeWorktreeFor({ repo, prNumber, removeWorktree, force });
        return NextResponse.json({
          killed: true,
          detail: "That session had already ended.",
          ...tidied,
        } satisfies KillTerminalResponse);
      }
      throw err;
    }

    await waitForTtysToClear(ttys);

    const tidied = await removeWorktreeFor({ repo, prNumber, removeWorktree, force });

    return NextResponse.json({
      killed: true,
      detail: `Ended ${sessionName}.`,
      ...tidied,
    } satisfies KillTerminalResponse);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return refuse(msg, 500);
  }
}
