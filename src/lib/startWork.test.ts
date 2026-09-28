import { describe, expect, it } from "vitest";
import {
  MAX_PR_TITLE,
  assignmentRefusal,
  draftPRBody,
  draftPRTitle,
  emptyCommitMessage,
  findConfiguredRepo,
  parseTicketId,
  pickInitialRepo,
  planIssueUpdate,
  startWorkSummary,
} from "./startWork";
import { stripTicketPrefix, ticketIdsFromPR } from "./view";
import type { AppConfig, StartWorkResponse } from "@/types";

describe("parseTicketId", () => {
  it("accepts the canonical form", () => {
    expect(parseTicketId("ENG-1234")).toBe("ENG-1234");
  });

  it("upper-cases and trims", () => {
    expect(parseTicketId("  eng-1234 ")).toBe("ENG-1234");
  });

  it("accepts a missing dash", () => {
    expect(parseTicketId("eng1234")).toBe("ENG-1234");
  });

  it("accepts a space or underscore instead of the dash", () => {
    expect(parseTicketId("ENG 1234")).toBe("ENG-1234");
    expect(parseTicketId("ENG_1234")).toBe("ENG-1234");
  });

  it("pulls the id out of a pasted Linear URL", () => {
    expect(
      parseTicketId("https://linear.app/northwind/issue/ENG-5800/delete-components"),
    ).toBe("ENG-5800");
  });

  it("takes the id segment of a URL, not the title slug", () => {
    // The slug can itself end in digits, which is what makes "last segment" wrong.
    expect(
      parseTicketId("https://linear.app/northwind/issue/ENG-5800/fixes-eng-1300"),
    ).toBe("ENG-5800");
  });

  it("rejects a bare number", () => {
    expect(parseTicketId("1234")).toBeNull();
  });

  it("rejects a bare prefix", () => {
    expect(parseTicketId("ENG-")).toBeNull();
  });

  it("rejects empty and whitespace", () => {
    expect(parseTicketId("")).toBeNull();
    expect(parseTicketId("   ")).toBeNull();
  });

  it("rejects prose that merely contains an id", () => {
    // Otherwise a stray paste starts work on whatever number it found.
    expect(parseTicketId("please start ENG-1234 today")).toBeNull();
  });
});

describe("findConfiguredRepo", () => {
  const config = {
    repos: [
      { owner: "Northwind", name: "billing-app" },
      { owner: "Northwind", name: "forms-app" },
    ],
  } as AppConfig;

  it("finds a configured repo", () => {
    expect(findConfiguredRepo(config, "Northwind/forms-app")?.name).toBe("forms-app");
  });

  it("matches case-insensitively, as GitHub does", () => {
    expect(findConfiguredRepo(config, "northwind/BILLING-app")?.name).toBe("billing-app");
  });

  it("returns null for a repo that isn't configured", () => {
    expect(findConfiguredRepo(config, "OtherOrg/thing")).toBeNull();
  });
});

describe("assignmentRefusal", () => {
  const viewerId = "me";

  it("allows an unassigned ticket", () => {
    expect(assignmentRefusal({ identifier: "ENG-1", assignee: null, viewerId })).toBeNull();
  });

  it("allows a ticket already assigned to you", () => {
    expect(
      assignmentRefusal({
        identifier: "ENG-1",
        assignee: { id: "me", name: "Alex Doe" },
        viewerId,
      }),
    ).toBeNull();
  });

  it("refuses someone else's ticket, naming them", () => {
    const refusal = assignmentRefusal({
      identifier: "ENG-1",
      assignee: { id: "sam", name: "Sam" },
      viewerId,
    });
    expect(refusal).toContain("ENG-1");
    expect(refusal).toContain("Sam");
  });

  it("treats a missing assignee field as unassigned", () => {
    expect(
      assignmentRefusal({ identifier: "ENG-1", assignee: undefined, viewerId }),
    ).toBeNull();
  });
});

describe("draftPRTitle", () => {
  it("brackets the identifier ahead of the title", () => {
    expect(draftPRTitle("ENG-1234", "Fix the thing")).toBe("[ENG-1234] Fix the thing");
  });

  // The whole reason for the brackets: the dashboard reads a PR's ticket off its
  // own title in this form and no other. A plain "ENG-1234: ..." would leave the
  // PR this feature creates unable to link back to the ticket that created it.
  it("produces a title the dashboard can read the ticket back out of", () => {
    const title = draftPRTitle("ENG-1234", "Fix the thing");
    expect(ticketIdsFromPR({ title, headRefName: "" })).toEqual(["ENG-1234"]);
  });

  it("produces a title that renders without its prefix", () => {
    expect(stripTicketPrefix(draftPRTitle("ENG-1234", "Fix the thing"))).toBe(
      "Fix the thing",
    );
  });

  it("truncates an over-long title", () => {
    const title = draftPRTitle("ENG-1234", "x".repeat(400));
    expect(title.length).toBe(MAX_PR_TITLE);
  });

  it("keeps the identifier when truncating", () => {
    // Truncation must eat the title, never the prefix — the prefix is the link.
    const title = draftPRTitle("ENG-1234", "x".repeat(400));
    expect(title.startsWith("[ENG-1234] ")).toBe(true);
    expect(ticketIdsFromPR({ title, headRefName: "" })).toEqual(["ENG-1234"]);
  });
});

describe("draftPRBody", () => {
  it("links the Linear issue by URL", () => {
    const body = draftPRBody({ identifier: "ENG-1234", url: "https://linear.app/x/issue/ENG-1234" });
    expect(body).toContain("[ENG-1234](https://linear.app/x/issue/ENG-1234)");
  });

  it("says the PR is empty on purpose", () => {
    expect(draftPRBody({ identifier: "ENG-1", url: "u" })).toMatch(/empty commit/i);
  });
});

describe("emptyCommitMessage", () => {
  it("names the ticket in the subject", () => {
    expect(emptyCommitMessage("ENG-1234").split("\n")[0]).toBe("chore: start ENG-1234");
  });

  it("explains why the commit is empty", () => {
    expect(emptyCommitMessage("ENG-1")).toMatch(/at least one commit/i);
  });
});

describe("planIssueUpdate", () => {
  const viewerId = "me";
  const teamStates = [
    { id: "s-progress", name: "In Progress" },
    { id: "s-backlog", name: "Backlog" },
    { id: "s-review", name: "In Review" },
  ];
  const base = {
    identifier: "ENG-1",
    viewerId,
    teamStates,
    inProgressStatusName: "In Progress",
  };

  it("assigns and moves an unassigned backlog ticket", () => {
    const plan = planIssueUpdate({
      ...base,
      assignee: null,
      state: { id: "s-backlog", name: "Backlog", type: "backlog" },
    });
    expect(plan.input).toEqual({ assigneeId: "me", stateId: "s-progress" });
    expect(plan.assigned).toBe(true);
    expect(plan.statusMoved).toBe(true);
    expect(plan.notes).toEqual([]);
  });

  it("moves a triage ticket too", () => {
    const plan = planIssueUpdate({
      ...base,
      assignee: null,
      state: { id: "s-triage", name: "Triage", type: "triage" },
    });
    expect(plan.input.stateId).toBe("s-progress");
  });

  it("skips assignment when the ticket is already yours, and says so", () => {
    const plan = planIssueUpdate({
      ...base,
      assignee: { id: "me", name: "Alex Doe" },
      state: { id: "s-backlog", name: "Backlog", type: "backlog" },
    });
    expect(plan.input.assigneeId).toBeUndefined();
    expect(plan.assigned).toBe(false);
    expect(plan.notes.join(" ")).toContain("already assigned to you");
  });

  // The regression this guards: "start work" on a ticket in review would
  // otherwise drag it backwards on the board.
  it("never moves a ticket that has already started", () => {
    const plan = planIssueUpdate({
      ...base,
      assignee: null,
      state: { id: "s-review", name: "In Review", type: "started" },
    });
    expect(plan.input.stateId).toBeUndefined();
    expect(plan.statusMoved).toBe(false);
    expect(plan.notes.join(" ")).toContain("already In Review");
  });

  it("never moves a completed ticket", () => {
    const plan = planIssueUpdate({
      ...base,
      assignee: null,
      state: { id: "s-done", name: "Done", type: "completed" },
    });
    expect(plan.input.stateId).toBeUndefined();
  });

  it("is a no-op on a ticket already yours and already In Progress", () => {
    const plan = planIssueUpdate({
      ...base,
      assignee: { id: "me", name: "Alex Doe" },
      state: { id: "s-progress", name: "In Progress", type: "started" },
    });
    expect(plan.input).toEqual({});
    expect(plan.notes).toHaveLength(2);
  });

  it("reports a configured status name the team doesn't have", () => {
    const plan = planIssueUpdate({
      ...base,
      inProgressStatusName: "Doing",
      assignee: null,
      state: { id: "s-backlog", name: "Backlog", type: "backlog" },
    });
    expect(plan.statusMoved).toBe(false);
    expect(plan.notes.join(" ")).toContain('No "Doing" status');
    // The assignment still goes ahead — one misconfigured key shouldn't cost both.
    expect(plan.input.assigneeId).toBe("me");
  });

  it("falls back to the team's first started status when the name is missing", () => {
    // A team whose in-progress column is called "Doing" still gets moved, to the
    // earliest state Linear files under "started", and is told which one.
    const typed = [
      { id: "s-backlog", name: "Backlog", type: "backlog", position: 0 },
      { id: "s-review", name: "In Review", type: "started", position: 3 },
      { id: "s-doing", name: "Doing", type: "started", position: 2 },
    ];
    const plan = planIssueUpdate({
      ...base,
      teamStates: typed,
      assignee: null,
      state: { id: "s-backlog", name: "Backlog", type: "backlog" },
    });
    expect(plan.input.stateId).toBe("s-doing");
    expect(plan.statusMoved).toBe(true);
    expect(plan.notes.join(" ")).toMatch(/No "In Progress" status.*moved to Doing/);
  });

  it("still leaves the status alone when the team has no started state at all", () => {
    const plan = planIssueUpdate({
      ...base,
      inProgressStatusName: "Doing",
      teamStates: [{ id: "s-backlog", name: "Backlog", type: "backlog", position: 0 }],
      assignee: null,
      state: { id: "s-backlog", name: "Backlog", type: "backlog" },
    });
    expect(plan.statusMoved).toBe(false);
  });

  it("matches the status name case-insensitively", () => {
    const plan = planIssueUpdate({
      ...base,
      inProgressStatusName: "in progress",
      assignee: null,
      state: { id: "s-backlog", name: "Backlog", type: "backlog" },
    });
    expect(plan.input.stateId).toBe("s-progress");
  });
});

describe("startWorkSummary", () => {
  const ok: StartWorkResponse = {
    started: true,
    ticket: { identifier: "ENG-1", title: "t", url: "u" },
    pr: { url: "pu", number: 7, repo: "Northwind/forms-app", branch: "b" },
    prCreated: true,
    assigned: true,
    statusMoved: true,
    notes: [],
  };

  it("reports what was opened and done", () => {
    expect(startWorkSummary(ok)).toBe(
      "Opened Northwind/forms-app#7 · assigned to you · status updated",
    );
  });

  // "Found" vs "Opened" is the difference between a second run being a no-op and
  // looking like it made a second PR.
  it("says found, not opened, when the PR already existed", () => {
    expect(startWorkSummary({ ...ok, prCreated: false })).toContain(
      "Found Northwind/forms-app#7",
    );
  });

  it("omits the parts that didn't happen", () => {
    expect(startWorkSummary({ ...ok, assigned: false, statusMoved: false })).toBe(
      "Opened Northwind/forms-app#7",
    );
  });

  it("reports the error when nothing started", () => {
    expect(
      startWorkSummary({ ...ok, started: false, pr: null, error: "nope" }),
    ).toBe("nope");
  });
});

describe("pickInitialRepo", () => {
  const repos = [
    { owner: "Northwind", name: "billing-app" },
    { owner: "Northwind", name: "forms-app" },
  ];

  it("uses the remembered repo", () => {
    expect(pickInitialRepo("Northwind/forms-app", repos)).toBe("Northwind/forms-app");
  });

  it("falls back to the first when nothing is remembered", () => {
    expect(pickInitialRepo(null, repos)).toBe("Northwind/billing-app");
  });

  // A repo dropped from config since the last run would otherwise leave the
  // select blank and post something the server refuses.
  it("ignores a remembered repo that is no longer configured", () => {
    expect(pickInitialRepo("Gone/away", repos)).toBe("Northwind/billing-app");
  });

  it("returns empty when there are no repos at all", () => {
    expect(pickInitialRepo("Northwind/billing-app", [])).toBe("");
  });
});
