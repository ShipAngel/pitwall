"use client";

import {
  openedAge,
  repoShortName,
  reviewRequestBadge,
  stripTicketPrefix,
} from "@/lib/view";
import type { ReviewRequestPR } from "@/types";
import Badge, { StateBadge } from "./Badge";
import CopyButton from "./CopyButton";
import TicketRefs from "./TicketRefs";

/**
 * PRs waiting on your review, as a flat queue rather than grouped by repo.
 *
 * Grouping is right for "My PRs", where the repo is the thing you scan by. Here
 * the question is only ever "what has been waiting longest", and repo headings
 * would bury a week-old request under whichever repo happened to sort first — so
 * the rows carry their own repo name instead.
 */
export default function ReviewRequestTable({
  prs,
  ticketIndex,
  ticketKeys,
  orgUrlKey,
}: {
  prs: ReviewRequestPR[];
  ticketIndex: Map<string, string[]>;
  /** Real Linear team keys, for bare ids in titles and branches. */
  ticketKeys: string[];
  orgUrlKey: string;
}) {
  if (prs.length === 0) {
    return (
      <p className="text-sm text-text-muted">Nothing is waiting on your review.</p>
    );
  }

  // Read once per render rather than ticked by a timer: the ages shown here are
  // hours and days, and the panel already re-renders on every refresh.
  const now = new Date();

  return (
    <ul className="space-y-1">
      {prs.map((pr) => {
        const age = openedAge(pr.createdAt, now);
        return (
          <li key={pr.url} className="flex items-center gap-2 text-sm">
            <CopyButton url={pr.url} label={`${pr.repo}#${pr.number}`} />
            {/* GitHub purple, as in the other table — colour alone says which
                system an identifier belongs to. The repo is named here because
                this list spans all of them. */}
            <a
              href={pr.url}
              target="_blank"
              rel="noreferrer"
              className="shrink-0 font-mono text-sm font-semibold text-accent-purple hover:underline"
              title={`${pr.repo}#${pr.number}`}
            >
              {repoShortName(pr.repo)}#{pr.number}
            </a>
            <TicketRefs pr={pr} ticketIndex={ticketIndex} ticketKeys={ticketKeys} orgUrlKey={orgUrlKey} />
            <a
              href={pr.url}
              target="_blank"
              rel="noreferrer"
              className="flex-1 truncate text-text-primary hover:text-accent-blue hover:underline"
              title={pr.title}
            >
              {stripTicketPrefix(pr.title, ticketKeys)}
            </a>
            {pr.author ? (
              <a
                href={`https://github.com/${pr.author}`}
                target="_blank"
                rel="noreferrer"
                className="w-44 shrink-0 truncate text-right font-mono text-xs text-text-muted hover:text-accent-blue hover:underline"
                title={`Opened by ${pr.author}`}
              >
                @{pr.author}
              </a>
            ) : (
              <span className="w-44 shrink-0 text-right font-mono text-xs text-text-dim">
                —
              </span>
            )}
            <span
              className="w-14 shrink-0 text-right text-xs text-text-muted"
              title={age.detail}
            >
              {age.label}
            </span>
            {/* A reserved slot, not a bare badge. Most rows have no state worth
                naming, so an inline badge only widened the rows that did — and
                pushed their author and age left, out of line with the rows
                above. Fixed width keeps every column straight down the list.
                Wide enough for the worst case rather than the common one: "wip"
                and "checks cancelled" can both be on one row, and a slot sized
                for the usual single badge squeezed them instead of aligning. */}
            <span className="flex w-48 shrink-0 items-center justify-end gap-2">
              {pr.isWip && <Badge kind="red">wip</Badge>}
              <StateBadge state={reviewRequestBadge(pr)} />
            </span>
          </li>
        );
      })}
    </ul>
  );
}
