"use client";

import { linearIssueUrl, splitBadges, ticketsForPR } from "@/lib/view";

/** Enough of any PR to resolve its tickets — `MyPR` and `ReviewRequestPR` both fit. */
type LinkablePR = { url: string; title: string; headRefName: string };

/**
 * The tickets a PR belongs to. A PR can serve several, so all are shown.
 *
 * On someone else's PR the Linear index usually has nothing — it is built from
 * *your* tickets — and the id falls back to the title and branch, which is
 * exactly the case this was written to cover.
 */
export default function TicketRefs({
  pr,
  ticketIndex,
  ticketKeys,
  orgUrlKey,
}: {
  pr: LinkablePR;
  ticketIndex: Map<string, string[]>;
  ticketKeys: string[];
  orgUrlKey: string;
}) {
  const ids = ticketsForPR(pr, ticketIndex, ticketKeys);
  if (ids.length === 0) {
    return (
      <span className="shrink-0 font-mono text-xs text-text-muted" title="No linked ticket">
        —
      </span>
    );
  }
  const { shown, hidden } = splitBadges(ids, 2);
  return (
    <span className="flex shrink-0 items-center gap-1" title={ids.join("\n")}>
      {shown.map((id) => {
        const href = linearIssueUrl(orgUrlKey, id);
        const cls = "inline-flex items-center rounded-sm border border-accent-blue/30 bg-accent-blue/15 px-1.5 py-0.5 font-mono text-xs font-medium text-accent-blue";
        return href ? (
          <a key={id} href={href} target="_blank" rel="noreferrer"
            className={`${cls} hover:bg-accent-blue/25 hover:underline`}>
            {id}
          </a>
        ) : (
          <span key={id} className={cls}>{id}</span>
        );
      })}
      {hidden > 0 && (
        <span className="font-mono text-xs text-text-muted">+{hidden}</span>
      )}
    </span>
  );
}
