"use client";

import { useKillTerminal } from "@/hooks/useKillTerminal";
import { terminalTabLabel } from "@/lib/terminal";
import { worktreeNote, type TerminalRow } from "@/lib/view";
import Badge from "./Badge";
import { sameTerminalKey } from "@/lib/terminal";

/**
 * The terminals and worktrees Pitwall is hosting — markup and event binding only.
 *
 * Separate from `SessionTable` because these are a different kind of thing: that
 * list is *discovered* in terminals you opened and can only be pointed at, this
 * one is *owned*, so each row offers what actually applies to it — open its dock
 * tab, end it, and remove the worktree it created.
 *
 * A row is one PR, not one tmux session, because the two halves outlive each
 * other: ending a session leaves its directory behind, and that directory has to
 * stay reachable or it is a leftover nothing can remove.
 */
export default function TerminalSessionTable({
  terminals,
  activeKey,
  onOpen,
  onEnded,
  onRefresh,
}: {
  terminals: TerminalRow[];
  /** Key of the dock tab currently showing, if any. */
  activeKey: string | null;
  onOpen: (row: TerminalRow) => void;
  /** Closes the dock pane for a session that no longer exists. */
  onEnded: (key: string) => void;
  /** Called after a kill, so the list drops the row it no longer has. */
  onRefresh: () => void;
}) {
  const { arming, pending, problem, notice, requestKill, cancel } =
    useKillTerminal((key) => {
      // Order matters only in that both must happen: the pane goes because its
      // session is gone, and the list refetches because the row must change too.
      onEnded(key);
      onRefresh();
    });

  if (terminals.length === 0) {
    return (
      <p className="text-sm text-text-muted">
        No hosted terminals. Open one from the terminal icon on a PR.
      </p>
    );
  }

  return (
    <ul className="space-y-1">
      {terminals.map((t) => {
        const isArmed = arming === t.key;
        const isActive = sameTerminalKey(activeKey, t.key);
        const note = worktreeNote(t);
        const canOpen = Boolean(t.pr && t.session);
        return (
          <li key={t.key}>
            <div className="flex items-center gap-2 rounded-sm px-1.5 py-1 text-sm transition hover:bg-bg-row">
              {/* Opening needs the branch and title, which live on the PR and
                  not in tmux — so once a PR merges, its session can still be
                  ended but no longer attached to. A row with only a worktree
                  has nothing to attach to at all. Disabled and said, rather
                  than a click that could only do nothing. */}
              <button
                type="button"
                onClick={() => onOpen(t)}
                disabled={!canOpen}
                title={
                  canOpen
                    ? `Show ${t.session!.sessionName} in the terminal dock`
                    : !t.session
                      ? "Only a worktree is left for this PR — there is no session to attach to"
                      : t.prKnown
                        ? `${t.repo}#${t.prNumber} is no longer among your open PRs, so this session can't be reattached — only ended`
                        : "Couldn't reach GitHub, so this PR's details aren't available to reattach with"
                }
                className="flex min-w-0 flex-1 items-center gap-2 text-left disabled:cursor-default disabled:opacity-60"
              >
                <span
                  aria-hidden
                  className={`shrink-0 font-mono text-xs ${
                    isActive
                      ? "text-accent-blue"
                      : canOpen
                        ? "text-accent-green"
                        : "text-text-dim"
                  }`}
                >
                  ›
                </span>
                <span className="shrink-0 font-mono text-sm font-semibold text-accent-purple">
                  {terminalTabLabel(t.repo, t.prNumber)}
                </span>
                {/* The worktree, not the session name. Which directory this
                    will delete is the thing worth reading before clicking;
                    the session name is derivable from the label beside it. */}
                <span
                  className={`flex-1 truncate font-mono text-xs ${
                    note.readOnly ? "italic text-text-dim" : "text-text-muted"
                  }`}
                  title={`${note.text}\n${note.detail}`}
                >
                  {note.text}
                </span>
                {/* "in dock", not tmux's own word for it. `attached` is exactly
                    right in tmux's vocabulary and meaningless in the panel's:
                    what it tells you is that a pane is open on this session,
                    which is what it should therefore say. Distinct from
                    "showing" — several panes can be open, one is visible. */}
                {t.session?.attached && <Badge kind="green">in dock</Badge>}
                {isActive && <Badge kind="blue">showing</Badge>}
                {!t.session && <Badge kind="neutral">no session</Badge>}
                {t.worktree?.dirty && <Badge kind="red">dirty</Badge>}
                {t.prKnown && !t.pr && <Badge kind="neutral">pr closed</Badge>}
              </button>

              {/* Two-step rather than a confirm dialog: this ends a Claude Code
                  session outright, so it shouldn't be one stray click, but it
                  also isn't worth a modal. The armed state is where the scope
                  is chosen, so "keep the worktree" and "delete it too" are the
                  same number of clicks and neither is the accidental one. */}
              {isArmed ? (
                <span className="flex shrink-0 items-center gap-1">
                  {t.session && (
                    <ArmedAction
                      label="End it"
                      onClick={() => requestKill(t.repo, t.prNumber)}
                      disabled={pending !== null}
                    />
                  )}
                  {t.worktree && !t.worktree.dirty && (
                    <ArmedAction
                      label={t.session ? "End + delete worktree" : "Delete worktree"}
                      onClick={() =>
                        requestKill(t.repo, t.prNumber, { removeWorktree: true })
                      }
                      disabled={pending !== null}
                    />
                  )}
                  {t.worktree?.dirty && (
                    <ArmedAction
                      label={t.session ? "End + delete anyway" : "Delete anyway"}
                      title={`${t.worktree.path} has uncommitted changes. They will be lost.`}
                      onClick={() =>
                        requestKill(t.repo, t.prNumber, {
                          removeWorktree: true,
                          force: true,
                        })
                      }
                      disabled={pending !== null}
                    />
                  )}
                  <button
                    type="button"
                    onClick={cancel}
                    className="rounded-sm px-1.5 py-0.5 text-xs text-text-muted transition hover:text-text-primary"
                  >
                    Cancel
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => requestKill(t.repo, t.prNumber)}
                  disabled={pending !== null}
                  aria-label={`Clean up ${t.repo}#${t.prNumber}`}
                  title={
                    t.session
                      ? "End this session — the Claude Code running in it is lost."
                      : "Remove the worktree left behind for this PR."
                  }
                  className="shrink-0 rounded-sm px-1 text-text-dim transition hover:bg-bg-row hover:text-accent-red disabled:opacity-60"
                >
                  {pending === t.key ? "·" : "×"}
                </button>
              )}
            </div>

            {isArmed && (
              <p className="px-1.5 pb-1 text-xs text-accent-yellow">
                {armedExplanation(t)}
              </p>
            )}
            {notice?.key === t.key && (
              <p className="px-1.5 pb-1 text-xs text-accent-yellow">{notice.detail}</p>
            )}
            {problem?.key === t.key && (
              <p className="px-1.5 pb-1 text-xs text-accent-yellow">
                {problem.detail}
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** One choice in the armed state. Red, because every one of them destroys something. */
function ArmedAction({
  label,
  title,
  onClick,
  disabled,
}: {
  label: string;
  title?: string;
  onClick: () => void;
  disabled: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="rounded-sm border border-accent-red/40 bg-accent-red/15 px-1.5 py-0.5 text-xs text-accent-red transition hover:bg-accent-red/25 disabled:opacity-60"
    >
      {label}
    </button>
  );
}

/** Spelling out what each armed row's options will actually do to it. */
function armedExplanation(t: TerminalRow): string {
  if (!t.session) {
    return t.worktree?.dirty
      ? "The worktree has uncommitted changes — deleting it loses them. The branch is kept."
      : "Removes the worktree from disk. The branch is kept.";
  }
  if (!t.worktree) {
    return "Ends the Claude Code session running in it. Pitwall didn't create a worktree for this PR, so there is nothing to remove.";
  }
  return t.worktree.dirty
    ? "Ends the Claude Code session. The worktree has uncommitted changes — deleting it loses them. The branch is kept either way."
    : "Ends the Claude Code session. Deleting the worktree also removes it from disk; the branch is kept either way.";
}
