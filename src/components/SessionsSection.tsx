"use client";

import { summarizeSessions } from "@/lib/sessions";
import { summarizeTerminalRows, type TerminalRow } from "@/lib/view";
import type { SessionsResponse } from "@/types";
import SessionTable from "./SessionTable";
import TerminalSessionTable from "./TerminalSessionTable";

/**
 * Two lists, not one, because they are two different kinds of thing.
 *
 * The first is *discovered*: Claude Code found running in a terminal you opened,
 * which this app can only bring to the front. The second is *owned*: tmux
 * sessions Pitwall started for a PR, which it can reattach the dock to and end.
 * Kept in one card because the question they answer is the same — what is Claude
 * doing right now — and split within it because the answers support different
 * actions.
 */
export default function SessionsSection({
  data,
  error,
  terminals,
  showTerminals,
  activeTerminalKey,
  onOpenTerminal,
  onEnded,
  onRefresh,
}: {
  data?: SessionsResponse;
  error?: string;
  /** Hosted terminals, already paired with their PRs by `terminalRows`. */
  terminals: TerminalRow[];
  /** Terminals are enabled; without this the second list is omitted entirely. */
  showTerminals: boolean;
  activeTerminalKey: string | null;
  onOpenTerminal: (row: TerminalRow) => void;
  /** The dock pane for a session that has just been ended. */
  onEnded: (key: string) => void;
  onRefresh: () => void;
}) {
  return (
    <div className="rounded-lg border border-line bg-bg-panel p-5">
      {/* An h2, not an h3: the Me tab has no section headings above its cards,
          so this is the top level under the page title. Self-describing for the
          same reason — nothing above it now says what these are.

          The count that used to sit beside it described only the discovered
          half, which stopped being right the moment there were two halves. Each
          list now carries its own, and they are h3 siblings at one size —
          previously the first list had no heading at all and the second had a
          smaller one, so they read as a list plus a footnote rather than as two
          halves of the same question. */}
      <h2 className="mb-4 text-base font-semibold">Claude Code Sessions</h2>

      {error && (
        <p className="rounded border border-accent-red/30 bg-accent-red/10 p-3 text-sm text-accent-red">
          {error}
        </p>
      )}
      {!error && !data && (
        <div className="space-y-2">
          {[0, 1].map((i) => (
            <div key={i} className="h-8 animate-pulse rounded bg-bg-row" />
          ))}
        </div>
      )}
      {!error && data && (
        <>
          {/* "Your terminals", not "iTerm2 sessions": only the rows that an
              iTerm2 window owns can be focused, and the rest are exactly why
              the `no window` badge exists — naming the whole list after iTerm2
              would be wrong for those. What every row here does have in common
              is that you started it. */}
          <ListHeading
            title="Your terminals"
            count={summarizeSessions(data.sessions)}
          />
          <SessionTable sessions={data.sessions} />
          {/* Why the list looks the way it does, when there is a reason beyond
              "nothing is running" — a denied Automation permission otherwise
              presents as an empty panel with no explanation. */}
          {data.unavailable && (
            <p className="mt-3 text-xs text-text-muted">{data.unavailable}</p>
          )}

          {/* Omitted rather than shown empty when terminals are off: an empty
              list would imply the feature is on and idle. */}
          {showTerminals && (
            <div className="mt-5 border-t border-line pt-4">
              <ListHeading
                title="Pitwall terminals"
                count={summarizeTerminalRows(terminals)}
              />
              <TerminalSessionTable
                terminals={terminals}
                activeKey={activeTerminalKey}
                onOpen={onOpenTerminal}
                onEnded={onEnded}
                onRefresh={onRefresh}
              />
            </div>
          )}
        </>
      )}
    </div>
  );
}

/**
 * One list's heading and count.
 *
 * Shared so the two are the same size and weight by construction rather than by
 * two class strings that happen to match today.
 */
function ListHeading({ title, count }: { title: string; count: string }) {
  return (
    <div className="mb-2 flex items-baseline justify-between">
      <h3 className="text-sm font-semibold text-text-primary">{title}</h3>
      <span className="text-xs text-text-muted">{count}</span>
    </div>
  );
}
