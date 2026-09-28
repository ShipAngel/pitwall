import { describe, expect, it } from "vitest";
import { groupTicketsByParent, sortTicketsByLane } from "./tickets";
import type { LinearTicket } from "@/types";

const ticket = (overrides: Partial<LinearTicket> = {}): LinearTicket => ({
  identifier: "ENG-1",
  title: "Test ticket",
  url: "https://linear.app/acme/issue/ENG-1",
  statusName: "In Progress",
  statusType: "started",
  statusColor: "#5e6ad2",
  statusPosition: 2,
  prs: [],
  parent: null,
  childCount: 0,
  cycleNumber: 54,
  isCurrentCycle: true,
  teamKey: "ENG",
  ...overrides,
});

describe("sortTicketsByLane", () => {
  it("orders lanes by state position, not by ticket number", () => {
    // Real positions: In Progress (2) < In Review (2.26) < In Acceptance (2.5),
    // but ticket numbers run the other way.
    const acceptance = ticket({
      identifier: "ENG-3700",
      statusName: "In Acceptance",
      statusPosition: 2.5,
    });
    const review = ticket({
      identifier: "ENG-4950",
      statusName: "In Review",
      statusPosition: 2.26,
    });
    const progress = ticket({
      identifier: "ENG-4900",
      statusName: "In Progress",
      statusPosition: 2,
    });

    const result = sortTicketsByLane([acceptance, review, progress]);
    expect(result.map((t) => t.statusName)).toEqual([
      "In Progress",
      "In Review",
      "In Acceptance",
    ]);
  });

  it("groups by board type order before position", () => {
    // 'unstarted' precedes 'started' on the Linear board, even when the
    // unstarted state sits at a higher position value than the started one.
    const started = ticket({ statusType: "started", statusPosition: 2 });
    const unstarted = ticket({
      identifier: "ENG-2",
      statusType: "unstarted",
      statusName: "Ready for Development",
      statusPosition: 999,
    });

    const result = sortTicketsByLane([started, unstarted]);
    expect(result[0].statusType).toBe("unstarted");
    expect(result[1].statusType).toBe("started");
  });

  it("orders tickets in Linear board lane order", () => {
    // Security (backlog) → Ready for Dev (unstarted) → In Progress → In
    // Acceptance (started) → Done (completed), with live position values.
    const done = ticket({
      identifier: "ENG-9",
      statusName: "Done",
      statusType: "completed",
      statusPosition: 3,
    });
    const inProgress = ticket({
      identifier: "ENG-3",
      statusName: "In Progress",
      statusType: "started",
      statusPosition: 2,
    });
    const security = ticket({
      identifier: "ENG-1",
      statusName: "Security",
      statusType: "backlog",
      statusPosition: 128.43,
    });
    const acceptance = ticket({
      identifier: "ENG-4",
      statusName: "In Acceptance",
      statusType: "started",
      statusPosition: 2.5,
    });
    const readyForDev = ticket({
      identifier: "ENG-2",
      statusName: "Ready for Development",
      statusType: "unstarted",
      statusPosition: 1,
    });

    const result = sortTicketsByLane([
      done,
      inProgress,
      security,
      acceptance,
      readyForDev,
    ]);
    expect(result.map((t) => t.statusName)).toEqual([
      "Security",
      "Ready for Development",
      "In Progress",
      "In Acceptance",
      "Done",
    ]);
  });

  it("uses ticket number only as a tiebreak within a single lane", () => {
    const higher = ticket({ identifier: "ENG-200" });
    const lower = ticket({ identifier: "ENG-100" });

    const result = sortTicketsByLane([higher, lower]);
    expect(result.map((t) => t.identifier)).toEqual(["ENG-100", "ENG-200"]);
  });

  it("prefers current-cycle tickets within the same lane", () => {
    const current = ticket({ identifier: "ENG-200", isCurrentCycle: true });
    const older = ticket({ identifier: "ENG-100", isCurrentCycle: false });

    // Same lane: current cycle wins even though ENG-100 sorts first by number.
    const result = sortTicketsByLane([older, current]);
    expect(result[0].identifier).toBe("ENG-200");
  });

  it("places unknown status types last", () => {
    const known = ticket({ statusType: "started" });
    const unknown = ticket({ identifier: "ENG-9", statusType: "mystery" });

    const result = sortTicketsByLane([unknown, known]);
    expect(result[0].statusType).toBe("started");
    expect(result[1].statusType).toBe("mystery");
  });

  it("does not mutate the input array", () => {
    const input = [
      ticket({ identifier: "ENG-2", statusPosition: 3 }),
      ticket({ identifier: "ENG-1", statusPosition: 1 }),
    ];
    const snapshot = [...input];
    sortTicketsByLane(input);
    expect(input).toEqual(snapshot);
  });
});

describe("groupTicketsByParent", () => {
  const child = (id: string, parentId: string, over = {}) =>
    ticket({
      identifier: id,
      parent: { identifier: parentId, title: `Parent ${parentId}` },
      ...over,
    });

  it("nests assigned children under their assigned parent", () => {
    const groups = groupTicketsByParent([
      ticket({ identifier: "ENG-5100", title: "Remove the legacy reports module" }),
      child("ENG-5411", "ENG-5100"),
      child("ENG-5412", "ENG-5100"),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].parent?.identifier).toBe("ENG-5100");
    expect(groups[0].parentTicket?.title).toBe("Remove the legacy reports module");
    expect(groups[0].tickets.map((r) => r.ticket.identifier)).toEqual([
      "ENG-5411",
      "ENG-5412",
    ]);
  });

  // The parent may belong to someone else; Linear still returns its identifier
  // and title on the child, which is enough to head the group.
  it("heads a group with an unassigned parent's details", () => {
    const groups = groupTicketsByParent([child("ENG-5411", "ENG-9000")]);
    expect(groups[0].parent).toEqual({
      identifier: "ENG-9000",
      title: "Parent ENG-9000",
    });
    expect(groups[0].parentTicket).toBeNull();
  });

  it("returns a loose ticket as its own group with no parent", () => {
    const groups = groupTicketsByParent([ticket({ identifier: "ENG-5401" })]);
    expect(groups).toEqual([
      { parent: null, parentTicket: null, tickets: [{ ticket: expect.objectContaining({ identifier: "ENG-5401" }), depth: 0 }] },
    ]);
  });

  it("keeps a parent with no assigned children as a loose ticket", () => {
    // A parent with 7 sub-issues, none of them assigned to the viewer.
    const groups = groupTicketsByParent([
      ticket({ identifier: "ENG-5200", childCount: 7 }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].parent).toBeNull();
    expect(groups[0].tickets[0].ticket.childCount).toBe(7);
  });

  it("places every ticket exactly once", () => {
    const input = [
      ticket({ identifier: "ENG-5100" }),
      child("ENG-5411", "ENG-5100"),
      child("ENG-5406", "ENG-5402"),
      ticket({ identifier: "ENG-5401" }),
    ];
    const seen = groupTicketsByParent(input).flatMap((g) => [
      ...(g.parentTicket ? [g.parentTicket.identifier] : []),
      ...g.tickets.map((r) => r.ticket.identifier),
    ]);
    expect(seen.sort()).toEqual(["ENG-5100", "ENG-5401", "ENG-5406", "ENG-5411"]);
  });

  it("renders a ticket that is both child and parent once, as a header", () => {
    const groups = groupTicketsByParent([
      child("ENG-5402", "ENG-5000"),
      child("ENG-5406", "ENG-5402"),
    ]);
    const appearances = groups.flatMap((g) => [
      ...(g.parentTicket ? [g.parentTicket.identifier] : []),
      ...g.tickets.map((r) => r.ticket.identifier),
    ]);
    expect(appearances.filter((id) => id === "ENG-5402")).toHaveLength(1);
  });

  it("orders groups and loose tickets together by lane", () => {
    const groups = groupTicketsByParent([
      ticket({ identifier: "ENG-1", statusType: "started", statusPosition: 3 }),
      ticket({ identifier: "ENG-2", statusType: "unstarted", statusPosition: 1 }),
      child("ENG-3", "ENG-2"),
    ]);
    // The unstarted family outranks the started loose ticket.
    expect(groups[0].parent?.identifier).toBe("ENG-2");
    expect(groups[1].tickets[0].ticket.identifier).toBe("ENG-1");
  });

  it("handles an empty list", () => {
    expect(groupTicketsByParent([])).toEqual([]);
  });
});

describe("groupTicketsByParent with chains deeper than two", () => {
  const kid = (id: string, parentId: string) =>
    ticket({
      identifier: id,
      parent: { identifier: parentId, title: `Parent ${parentId}` },
    });

  // A chain of assigned tickets used to lose its middle links: each intermediate
  // had only header children, so its group was skipped and it fell through to the
  // loose pass, rendering as an unrelated standalone despite having a real parent.
  it("keeps a three-deep assigned chain in one family", () => {
    const groups = groupTicketsByParent([
      ticket({ identifier: "ENG-1", title: "Grandparent" }),
      kid("ENG-2", "ENG-1"),
      kid("ENG-3", "ENG-2"),
      kid("ENG-4", "ENG-3"),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].parent?.identifier).toBe("ENG-1");
    expect(groups[0].tickets.map((r) => r.ticket.identifier).sort()).toEqual([
      "ENG-2",
      "ENG-3",
      "ENG-4",
    ]);
  });

  it("leaves no ticket looking parentless when it has an assigned ancestor", () => {
    const groups = groupTicketsByParent([
      ticket({ identifier: "ENG-1" }),
      kid("ENG-2", "ENG-1"),
      kid("ENG-3", "ENG-2"),
    ]);
    const loose = groups.filter((g) => g.parent === null);
    expect(loose).toEqual([]);
  });

  it("still places every ticket exactly once in a deep chain", () => {
    const input = [
      ticket({ identifier: "ENG-1" }),
      kid("ENG-2", "ENG-1"),
      kid("ENG-3", "ENG-2"),
      kid("ENG-4", "ENG-3"),
    ];
    const seen = groupTicketsByParent(input).flatMap((g) => [
      ...(g.parentTicket ? [g.parentTicket.identifier] : []),
      ...g.tickets.map((r) => r.ticket.identifier),
    ]);
    expect(seen.sort()).toEqual(["ENG-1", "ENG-2", "ENG-3", "ENG-4"]);
  });

  it("survives a parent cycle without hanging", () => {
    // Linear shouldn't allow this, but a guard beats an infinite loop.
    const a = ticket({ identifier: "ENG-1", parent: { identifier: "ENG-2", title: "b" } });
    const b = ticket({ identifier: "ENG-2", parent: { identifier: "ENG-1", title: "a" } });
    expect(() => groupTicketsByParent([a, b])).not.toThrow();
  });
});

describe("groupTicketsByParent nesting depth", () => {
  const t = (id: string, parent?: string) =>
    ticket({
      identifier: id,
      parent: parent ? { identifier: parent, title: `${parent} title` } : null,
    });

  /** Rows as `identifier@depth`, which is the whole shape under test. */
  const shape = (g: { tickets: Array<{ ticket: { identifier: string }; depth: number }> }) =>
    g.tickets.map((r) => `${r.ticket.identifier}@${r.depth}`);

  // The change itself: a sub-issue's sub-issue used to be flattened onto the
  // root and rendered as if it were a sibling of its own parent.
  it("puts a sub-issue's sub-issue a rung below its parent", () => {
    const groups = groupTicketsByParent([
      t("ENG-1"),
      t("ENG-2", "ENG-1"),
      t("ENG-3", "ENG-2"),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].parentTicket?.identifier).toBe("ENG-1");
    expect(shape(groups[0])).toEqual(["ENG-2@0", "ENG-3@1"]);
  });

  it("keeps siblings level with each other", () => {
    const groups = groupTicketsByParent([
      t("ENG-1"),
      t("ENG-2", "ENG-1"),
      t("ENG-3", "ENG-1"),
      t("ENG-4", "ENG-2"),
    ]);
    expect(shape(groups[0])).toEqual(["ENG-2@0", "ENG-4@1", "ENG-3@0"]);
  });

  it("nests under an unassigned parent's stub without duplicating anything", () => {
    // The bug this caught: ENG-2 headed a family of its own *and* appeared as a
    // row under the stub, so it rendered twice.
    const groups = groupTicketsByParent([t("ENG-2", "ENG-99"), t("ENG-3", "ENG-2")]);
    expect(groups).toHaveLength(1);
    expect(groups[0].parent?.identifier).toBe("ENG-99");
    expect(groups[0].parentTicket).toBeNull();
    expect(shape(groups[0])).toEqual(["ENG-2@0", "ENG-3@1"]);
  });

  it("lists a chain deeper than the indent cap in full, without indenting further", () => {
    const groups = groupTicketsByParent([
      t("ENG-1"),
      t("ENG-2", "ENG-1"),
      t("ENG-3", "ENG-2"),
      t("ENG-4", "ENG-3"),
      t("ENG-5", "ENG-4"),
    ]);
    // Every ticket is still present; only the indent stops growing.
    expect(shape(groups[0])).toEqual(["ENG-2@0", "ENG-3@1", "ENG-4@2", "ENG-5@2"]);
  });

  it("places every ticket exactly once across a deep tree", () => {
    const all = [
      t("ENG-1"),
      t("ENG-2", "ENG-1"),
      t("ENG-3", "ENG-2"),
      t("ENG-4", "ENG-1"),
      t("ENG-5"),
    ];
    const groups = groupTicketsByParent(all);
    const seen = groups.flatMap((g) => [
      ...(g.parentTicket ? [g.parentTicket.identifier] : []),
      ...g.tickets.map((r) => r.ticket.identifier),
    ]);
    expect([...seen].sort()).toEqual(["ENG-1", "ENG-2", "ENG-3", "ENG-4", "ENG-5"]);
  });

  // A parent cycle is the only way a ticket can reach two header keys: rootOf
  // stops at the repeat, so each member reports a different root. The first
  // version of this test only bounded the row count, which let the duplicate
  // through — every ticket must appear exactly once, header rows included.
  it("survives a parent cycle without rendering anything twice", () => {
    const groups = groupTicketsByParent([t("ENG-1", "ENG-2"), t("ENG-2", "ENG-1")]);
    const appearances = groups.flatMap((g) => [
      ...(g.parentTicket ? [g.parentTicket.identifier] : []),
      ...g.tickets.map((r) => r.ticket.identifier),
    ]);
    expect([...appearances].sort()).toEqual(["ENG-1", "ENG-2"]);
  });

  it("keeps a three-way parent cycle to one appearance each", () => {
    const groups = groupTicketsByParent([
      t("ENG-1", "ENG-3"),
      t("ENG-2", "ENG-1"),
      t("ENG-3", "ENG-2"),
    ]);
    const appearances = groups.flatMap((g) => [
      ...(g.parentTicket ? [g.parentTicket.identifier] : []),
      ...g.tickets.map((r) => r.ticket.identifier),
    ]);
    expect([...appearances].sort()).toEqual(["ENG-1", "ENG-2", "ENG-3"]);
  });
});
