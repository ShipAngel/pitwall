"use client";

import type { LinearTicket, TicketGroup } from "@/types";
import { groupTicketsByParent } from "@/lib/tickets";
import CopyButton from "./CopyButton";
import { linearIssueUrl, splitBadges, splitPRsByState, ticketIndent } from "@/lib/view";

/**
 * The pull requests linked to a ticket.
 *
 * Only PRs still open get a badge. Linear keeps every PR it ever attached, so a
 * ticket can carry a dozen merged ones — rendering those as equals implied live
 * work that had long since shipped. Finished PRs collapse to a muted count.
 */
function PRRefs({ ticket }: { ticket: LinearTicket }) {
  const { open, finished } = splitPRsByState(ticket.prs);
  if (open.length === 0 && finished === 0) return null;
  const { shown, hidden } = splitBadges(open, 2);
  return (
    <span
      className="flex shrink-0 items-center gap-1.5"
      title={ticket.prs
        .map((p) => `${p.repo}#${p.number} — ${p.isDraft ? "draft" : p.status}`)
        .join("\n")}
    >
      {shown.map((p) => (
        <a
          key={p.url}
          href={p.url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center rounded border border-accent-purple/30 bg-accent-purple/15 px-1.5 py-0.5 font-mono text-xs font-medium text-accent-purple hover:bg-accent-purple/25 hover:underline"
        >
          #{p.number}
          {p.isDraft && <span className="ml-1 text-text-muted">draft</span>}
        </a>
      ))}
      {hidden > 0 && (
        <span className="font-mono text-xs text-text-muted">+{hidden}</span>
      )}
      {finished > 0 && (
        <span
          className="font-mono text-xs text-text-muted"
          title={`${finished} linked PR${finished === 1 ? "" : "s"} already merged or closed`}
        >
          {finished} done
        </span>
      )}
    </span>
  );
}

/** The ticket's workflow state, tinted with the colour Linear assigns it. */
function StatusBadge({ ticket }: { ticket: LinearTicket }) {
  const color = ticket.statusColor || "#8a93a0";
  return (
    <span
      className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs font-medium uppercase tracking-wide"
      style={{
        color,
        backgroundColor: `${color}22`,
        borderColor: `${color}55`,
      }}
    >
      <span
        className="h-1.5 w-1.5 rounded-full"
        style={{ backgroundColor: color }}
      />
      {ticket.statusName}
    </span>
  );
}

/**
 * The cycle, shown only when it isn't the current one. Nearly every assigned
 * ticket sits in the current cycle, so labelling all of them repeated the same
 * value down the whole list and ate the width the titles needed. The current
 * cycle is named once in the panel subtitle instead; what stands out here is a
 * ticket that is *not* in it.
 */
function CycleBadge({
  ticket,
  teamsWithoutCycles,
}: {
  ticket: LinearTicket;
  teamsWithoutCycles: readonly string[];
}) {
  if (ticket.cycleNumber == null) {
    // On a team without cycles every ticket is "not in a cycle", so the dash
    // would only repeat down the list. Per ticket, because the list can span
    // teams and only some of them may use cycles.
    if (teamsWithoutCycles.includes(ticket.teamKey)) return null;
    return <span className="text-xs text-text-muted" title="Not in a cycle">—</span>;
  }
  if (ticket.isCurrentCycle) return null;
  return (
    <span
      className="shrink-0 text-xs text-accent-yellow"
      title={`In cycle ${ticket.cycleNumber}, not the current one`}
    >
      cycle {ticket.cycleNumber}
    </span>
  );
}

/** One ticket, as a row. Indentation comes from the family wrapper. */
function TicketRow({
  ticket,
  teamsWithoutCycles,
}: {
  ticket: LinearTicket;
  teamsWithoutCycles: readonly string[];
}) {
  return (
    <li className="flex items-center gap-2 text-sm">
      <CopyButton url={ticket.url} label={ticket.identifier} />
      <a
        href={ticket.url}
        target="_blank"
        rel="noreferrer"
        className="shrink-0 font-mono text-sm font-semibold text-accent-blue hover:underline"
      >
        {ticket.identifier}
      </a>
      <a
        href={ticket.url}
        target="_blank"
        rel="noreferrer"
        className="flex-1 truncate text-text-primary hover:text-accent-blue hover:underline"
        title={ticket.title}
      >
        {ticket.title}
      </a>
      {ticket.childCount > 0 && (
        <span
          className="shrink-0 text-xs text-text-muted"
          title={`${ticket.childCount} sub-issues in Linear`}
        >
          {ticket.childCount} sub
        </span>
      )}
      <PRRefs ticket={ticket} />
      <CycleBadge ticket={ticket} teamsWithoutCycles={teamsWithoutCycles} />
      <StatusBadge ticket={ticket} />
    </li>
  );
}

/**
 * A family header for a parent that isn't assigned to the viewer, so there is no
 * ticket row to show — just enough to name and link the parent.
 */
function ParentHeader({ group, orgUrlKey }: { group: TicketGroup; orgUrlKey: string }) {
  const parent = group.parent;
  if (!parent) return null;
  const href = linearIssueUrl(orgUrlKey, parent.identifier);
  return (
    <li className="flex items-center gap-2 pt-1 text-sm">
      {/* A plain span without a link target: an <a href={undefined}> is not
          focusable, so it would read as clickable to the eye but not to a
          keyboard. Same pattern as TicketRefs in PRTable. */}
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className="shrink-0 font-mono text-sm font-semibold text-accent-blue/70 hover:underline"
        >
          {parent.identifier}
        </a>
      ) : (
        <span className="shrink-0 font-mono text-sm font-semibold text-accent-blue/70">
          {parent.identifier}
        </span>
      )}
      <span className="flex-1 truncate text-text-muted" title={parent.title}>
        {parent.title}
      </span>
      <span className="shrink-0 text-xs text-text-muted">not assigned to you</span>
    </li>
  );
}

export default function TicketTable({
  tickets,
  orgUrlKey,
  teamsWithoutCycles,
}: {
  tickets: LinearTicket[];
  orgUrlKey: string;
  /** Teams Linear says don't use cycles; their tickets get no cycle badge. */
  teamsWithoutCycles: readonly string[];
}) {
  if (tickets.length === 0) {
    return <p className="text-sm text-text-muted">No assigned tickets.</p>;
  }

  const groups = groupTicketsByParent(tickets);

  return (
    <ul className="space-y-1.5">
      {groups.map((g) => {
        // A loose ticket is a group of one with no parent — a plain row.
        if (!g.parent) {
          return (
            <TicketRow
              teamsWithoutCycles={teamsWithoutCycles}
              key={g.tickets[0].ticket.identifier}
              ticket={g.tickets[0].ticket}
            />
          );
        }
        return (
          <li key={g.parent.identifier}>
            <ul className="space-y-1.5">
              {g.parentTicket ? (
                <TicketRow ticket={g.parentTicket} teamsWithoutCycles={teamsWithoutCycles} />
              ) : (
                <ParentHeader group={g} orgUrlKey={orgUrlKey} />
              )}
              {/* One continuous rule per rung, so a sub-issue's own sub-issues
                  read as a level down rather than as siblings. The rule is what
                  carries the nesting — indentation alone was ambiguous once
                  there was more than one depth to tell apart. */}
              <li>
                <ul className="ml-2 space-y-1.5 border-l border-line pl-3">
                  {g.tickets.map((r) => (
                    <li key={r.ticket.identifier}>
                      <ul {...ticketIndent(r.depth)}>
                        <TicketRow ticket={r.ticket} teamsWithoutCycles={teamsWithoutCycles} />
                      </ul>
                    </li>
                  ))}
                </ul>
              </li>
            </ul>
          </li>
        );
      })}
    </ul>
  );
}
