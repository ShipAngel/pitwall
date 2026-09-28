import type { LinearTicket, TicketGroup, TicketGroupRow, TicketParent } from "@/types";

// Workflow-state types in Linear's canonical board order (left to right).
// Within a single type, tickets are then ordered by the state's position —
// together this reproduces the swim-lane order shown on the Linear board,
// e.g. Backlog (backlog) → Todo (unstarted) → In Progress → In Review
// (started) → Done (completed).
export const STATUS_TYPE_ORDER: Record<string, number> = {
  triage: 0,
  backlog: 1,
  unstarted: 2,
  started: 3,
  completed: 4,
  canceled: 5,
};

/**
 * Order tickets the way the Linear board reads: grouped by workflow-state type,
 * then by each state's position within that type (the order the swim lanes
 * appear on the board). Ticket number is only a final tiebreak within one lane.
 */
function byLane(a: LinearTicket, b: LinearTicket): number {
  const aType = STATUS_TYPE_ORDER[a.statusType] ?? 99;
  const bType = STATUS_TYPE_ORDER[b.statusType] ?? 99;
  if (aType !== bType) return aType - bType;
  if (a.statusPosition !== b.statusPosition) {
    return a.statusPosition - b.statusPosition;
  }
  if (a.isCurrentCycle !== b.isCurrentCycle) {
    return a.isCurrentCycle ? -1 : 1;
  }
  return a.identifier.localeCompare(b.identifier);
}

/**
 * Order tickets the way the Linear board reads: grouped by workflow-state type,
 * then by each state's position within that type. Ticket number is only a final
 * tiebreak within one lane.
 */
export function sortTicketsByLane(tickets: LinearTicket[]): LinearTicket[] {
  return [...tickets].sort(byLane);
}

/** Depth cap when walking a parent chain, so a cycle can't loop forever. */
const MAX_PARENT_DEPTH = 20;

/**
 * Deepest rung that still earns its own indent.
 *
 * Nesting is what the hierarchy is *for*, so this isn't a limit on how deep a
 * family may go — every descendant is still listed. It only stops the indent
 * growing, because at this width a fourth rung costs more readability than the
 * relationship it shows, and a pathological chain would otherwise walk the rows
 * off the right of the panel.
 */
export const MAX_TICKET_INDENT = 2;

/**
 * Groups assigned tickets into families by their Linear parent.
 *
 * Every entry is a group, so the caller renders one shape. `parent === null`
 * means a single ungrouped ticket — a plain row. Groups and loose tickets are
 * ordered together by lane, so an urgent standalone ticket isn't pushed below
 * the families.
 *
 * A chain is rooted at its **topmost assigned ancestor**, and every descendant
 * below that is carried with the depth it actually sits at. Rooting matters
 * independently of depth: without it an intermediate ticket had only header
 * children, its group was skipped, and it fell through to the loose pass —
 * rendering as an unrelated standalone despite having a real parent and children
 * in Linear.
 *
 * Descendants used to be flattened onto the root, so a sub-issue's own
 * sub-issues rendered beside their parent as if they were siblings. They now
 * nest, with `MAX_TICKET_INDENT` capping the indent rather than the depth — a
 * chain deeper than that still lists in full, it just stops stepping right.
 *
 * `MAX_PARENT_DEPTH` is a separate, far higher cap on the walk itself. Anything
 * below it is left unplaced and picked up by the loose pass at the end, so it
 * renders as a standalone row rather than disappearing. That is the safe
 * fallback rather than the intent: at twenty rungs the chain is a Linear
 * accident, not a hierarchy worth drawing.
 *
 * A parent that isn't assigned to the viewer still heads its group, using the
 * identifier and title Linear returns on the child. A ticket that heads a family
 * is never also listed as another family's child, so nothing appears twice.
 */
export function groupTicketsByParent(tickets: LinearTicket[]): TicketGroup[] {
  const byId = new Map(tickets.map((t) => [t.identifier, t]));

  // Walks up while each parent is itself assigned. Returns the ticket unchanged
  // when its parent isn't assigned (or it has none), which is what distinguishes
  // "belongs to an assigned family" from "heads one".
  const rootOf = (t: LinearTicket): LinearTicket => {
    let cur = t;
    const seen = new Set<string>([t.identifier]);
    for (let depth = 0; depth < MAX_PARENT_DEPTH; depth++) {
      const parentId = cur.parent?.identifier;
      if (!parentId || seen.has(parentId)) break;
      const next = byId.get(parentId);
      if (!next) break;
      seen.add(parentId);
      cur = next;
    }
    return cur;
  };

  // Immediate children only, keyed by the parent each ticket actually names.
  // The family's shape is walked from this rather than flattened into it, which
  // is what lets a sub-issue of a sub-issue sit a rung lower instead of beside
  // the ticket it belongs to.
  const kidsOf = new Map<string, LinearTicket[]>();
  const unassignedParents = new Map<string, TicketParent>();
  for (const t of tickets) {
    const parentId = t.parent?.identifier;
    if (!parentId) continue;
    const kids = kidsOf.get(parentId);
    if (kids) kids.push(t);
    else kidsOf.set(parentId, [t]);
    if (!byId.has(parentId)) unassignedParents.set(parentId, t.parent!);
  }

  /**
   * Every descendant of `id`, depth-first and lane-ordered at each level.
   *
   * `seen` is shared across the whole walk rather than per branch: a parent
   * cycle in Linear would otherwise recurse until the depth cap on every path.
   */
  const descend = (id: string, depth: number, seen: Set<string>): TicketGroupRow[] => {
    if (depth > MAX_PARENT_DEPTH) return [];
    const rows: TicketGroupRow[] = [];
    for (const kid of sortTicketsByLane(kidsOf.get(id) ?? [])) {
      if (seen.has(kid.identifier)) continue;
      seen.add(kid.identifier);
      rows.push({ ticket: kid, depth: Math.min(depth, MAX_TICKET_INDENT) });
      rows.push(...descend(kid.identifier, depth + 1, seen));
    }
    return rows;
  };

  // A family is headed by the topmost assigned ancestor — or, when even that
  // has a parent the viewer isn't assigned, by that unassigned parent as a stub.
  // Reading `root.parent` rather than the ticket's own is what keeps the two
  // cases in step: keying a mid-chain ticket on itself made it head a family
  // while it was also a row inside the stub's, so it appeared twice.
  const headerKeys = new Set<string>();
  for (const t of tickets) {
    if (!t.parent) continue;
    const root = rootOf(t);
    headerKeys.add(root.parent ? root.parent.identifier : root.identifier);
  }

  const groups: TicketGroup[] = [];
  const placed = new Set<string>();

  for (const key of headerKeys) {
    // A ticket already inside another family can't also head one. Only a parent
    // cycle makes this reachable — `rootOf` stops at the repeat, so each member
    // of the cycle reports a different root and both become header keys — but
    // the result was the same ticket rendered as a header *and* as a row within
    // its own family.
    if (placed.has(key)) continue;
    const parentTicket = byId.get(key) ?? null;
    // Seeded with what is already placed, and with this header, so the walk
    // can't re-emit a ticket into a second family or into its own.
    const rows = descend(key, 0, new Set<string>([...placed, key]));
    if (rows.length === 0) continue;
    const parent = parentTicket
      ? { identifier: parentTicket.identifier, title: parentTicket.title }
      : unassignedParents.get(key);
    if (!parent) continue;
    groups.push({ parent, parentTicket, tickets: rows });
    for (const r of rows) placed.add(r.ticket.identifier);
    if (parentTicket) placed.add(parentTicket.identifier);
  }

  for (const t of tickets) {
    if (placed.has(t.identifier)) continue;
    groups.push({ parent: null, parentTicket: null, tickets: [{ ticket: t, depth: 0 }] });
  }

  // A group sorts by its header when the parent is assigned, otherwise by its
  // most advanced child — the same lane order used within a group.
  const rep = (g: TicketGroup) => g.parentTicket ?? g.tickets[0].ticket;
  return groups.sort((a, b) => byLane(rep(a), rep(b)));
}
