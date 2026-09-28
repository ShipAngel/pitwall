"use client";

import { mergeReadiness, reviewBadge, stripTicketPrefix } from "@/lib/view";
import type { MyPR, RepoConfig } from "@/types";
import Badge, { StateBadge } from "./Badge";
import CopyButton from "./CopyButton";
import TerminalButton from "./TerminalButton";
import TicketRefs from "./TicketRefs";

type Group = { repo: RepoConfig; prs: MyPR[] };

/** Composes the extracted reviewBadge decision with the markup that shows it. */
function renderReviewBadge(pr: MyPR) {
  const { kind, label } = reviewBadge(pr);
  return <Badge kind={kind}>{label}</Badge>;
}

export default function PRTable({
  groups,
  ticketIndex,
  ticketKeys,
  orgUrlKey,
  onOpenTerminal,
}: {
  groups: Group[];
  ticketIndex: Map<string, string[]>;
  /** Real Linear team keys, for bare ids in titles and branches. */
  ticketKeys: string[];
  orgUrlKey: string;
  /** Absent when terminals are disabled, which hides the button entirely. */
  onOpenTerminal?: (pr: MyPR) => void;
}) {
  const nonEmpty = groups
    .filter((g) => g.prs.length > 0)
    .sort((a, b) => b.prs.length - a.prs.length);
  if (nonEmpty.length === 0) {
    return (
      <p className="text-sm text-text-muted">No open PRs across configured repos.</p>
    );
  }

  return (
    <div className="space-y-4">
      {nonEmpty.map((g) => {
        const approved = g.prs.filter((p) => p.reviewDecision === "APPROVED").length;
        // A repo with no local clone can't host a worktree, so its rows get no
        // button rather than one that fails on click.
        const canOpenTerminal = onOpenTerminal && g.repo.localPath ? onOpenTerminal : null;
        return (
          <div key={`${g.repo.owner}/${g.repo.name}`}>
            <div className="flex items-baseline justify-between border-b border-line pb-1">
              <span className="text-sm font-medium">{g.repo.name}</span>
              <span className="text-xs text-text-muted">
                {approved > 0
                  ? `${g.prs.length} open · ${approved} approved`
                  : `${g.prs.length} open`}
              </span>
            </div>
            <ul className="mt-1.5 space-y-1">
              {g.prs.map((pr) => (
                <li key={pr.url} className="flex items-center gap-2 text-sm">
                  {canOpenTerminal && !pr.isCrossRepository && (
                    <TerminalButton pr={pr} onOpen={canOpenTerminal} />
                  )}
                  {/* Same width as the button, so rows stay aligned. */}
                  {canOpenTerminal && pr.isCrossRepository && (
                    <span
                      className="w-[18px] shrink-0"
                      title="Opened from a fork, so there's no branch on origin to open a terminal on"
                    />
                  )}
                  <CopyButton url={pr.url} label={`${pr.repo}#${pr.number}`} />
                  {/* Identifiers are coloured by the system they belong to:
                      GitHub purple, Linear blue. Colour alone then says which id
                      you are looking at, which a shared grey never did. */}
                  <a
                    href={pr.url}
                    target="_blank"
                    rel="noreferrer"
                    className="shrink-0 font-mono text-sm font-semibold text-accent-purple hover:underline"
                    title={`${pr.repo}#${pr.number}`}
                  >
                    #{pr.number}
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
                  {pr.isWip && <Badge kind="red">wip</Badge>}
                  {renderReviewBadge(pr)}
                  {/* Merge state sits beside the review decision rather than
                      instead of it: "approved" and "conflicts" are both true and
                      both worth seeing. Absent until GitHub computes it. */}
                  <StateBadge state={mergeReadiness(pr)} />
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}
