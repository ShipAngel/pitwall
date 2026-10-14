"use client";

import { useFocusSession } from "@/hooks/useFocusSession";
import type { ClaudeSession } from "@/types";
import Badge from "./Badge";

/**
 * The clickable session list — markup and event binding only; the request lives
 * in `useFocusSession`.
 *
 * A row is a button rather than a link because the focus endpoint refuses
 * anything that isn't a same-origin POST from this page.
 */
export default function SessionTable({ sessions }: { sessions: ClaudeSession[] }) {
  const { pending, problem, focus } = useFocusSession();

  if (sessions.length === 0) {
    return (
      <p className="text-sm text-text-muted">No Claude Code sessions running.</p>
    );
  }

  return (
    <ul className="space-y-1">
      {sessions.map((s) => (
        <li key={s.tty}>
          {/* Every row disables while any focus is outstanding, not only the one
              clicked — see the note on `pending` in useFocusSession. */}
          <button
            type="button"
            onClick={() => focus(s.tty)}
            disabled={!s.canFocus || pending !== null}
            title={
              s.canFocus
                ? `Bring ${s.tty} to the front${s.cwd ? ` — ${s.path}` : ""}`
                : `${s.tty} isn't an iTerm2 window, so it can't be focused`
            }
            className="flex w-full items-center gap-2 rounded-sm px-1.5 py-1 text-left text-sm transition-ui hover:bg-bg-row disabled:cursor-default disabled:opacity-60 disabled:hover:bg-transparent"
          >
            <span
              aria-hidden
              className={`shrink-0 font-mono text-xs ${s.canFocus ? "text-accent-green" : "text-text-dim"}`}
            >
              {pending === s.tty ? "·" : "›"}
            </span>
            <span className="shrink-0 font-mono text-sm font-semibold text-accent-purple">
              {s.workspace || "unknown"}
            </span>
            {/* An idle session has no task to name, so it shows where it is
                instead — never a blank cell. */}
            {s.title ? (
              <span className="flex-1 truncate text-text-primary" title={s.title}>
                {s.title}
              </span>
            ) : (
              <span className="flex-1 truncate font-mono text-xs text-text-dim" title={s.path}>
                {s.path || "unknown directory"}
              </span>
            )}
            <span className="w-24 shrink-0 text-right font-mono text-xs text-text-muted">
              {s.tty.replace("/dev/", "")}
            </span>
            {s.isWorking && <Badge kind="green">working</Badge>}
            {!s.canFocus && <Badge kind="neutral">no window</Badge>}
          </button>
          {problem?.tty === s.tty && (
            <p className="px-1.5 pb-1 text-xs text-accent-yellow">{problem.detail}</p>
          )}
        </li>
      ))}
    </ul>
  );
}
