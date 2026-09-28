import type { RepoConfig, StartWorkResponse } from "@/types";

/**
 * The decisions behind "start work on a ticket", with no network in sight.
 *
 * The route does the four round trips (read Linear, read GitHub, write GitHub,
 * write Linear); everything about *what* to write is here, because all of it is
 * a rule someone will want to change: which inputs count as a ticket id, what
 * the PR is called, when the ticket is someone else's, and when moving its
 * status would undo work rather than start it.
 */

export const DEFAULT_IN_PROGRESS_STATUS = "In Progress";

/**
 * GitHub rejects a pull request title over 256 characters. Linear titles are
 * routinely long, and the identifier prefix has to survive the truncation — it
 * is the part that makes the PR findable.
 */
export const MAX_PR_TITLE = 256;

/**
 * A Linear identifier as typed, pasted, or copied out of a URL.
 *
 * Deliberately forgiving on input and strict on output. "eng 5700", "ENG5700"
 * and a full issue URL all mean the same ticket, and rejecting them would only
 * teach you to reformat by hand — but everything downstream (the Linear lookup,
 * the PR title) gets the one canonical spelling.
 *
 * Returns null for anything that isn't a `PREFIX-NUMBER`, so the caller reports
 * bad input rather than sending it upstream to fail less clearly.
 */
export function parseTicketId(raw: string): string | null {
  if (typeof raw !== "string") return null;

  // A pasted URL: linear.app/<org>/issue/ENG-5800/<slug>. Taking the segment
  // after "issue" rather than the last one, which is the title slug.
  let text = raw.trim();
  const fromUrl = /\/issue\/([A-Za-z][A-Za-z0-9]*-\d+)/i.exec(text);
  if (fromUrl) text = fromUrl[1];

  const m = /^([A-Za-z][A-Za-z0-9]*?)[-_\s]*(\d+)$/.exec(text.trim());
  if (!m) return null;
  return `${m[1].toUpperCase()}-${m[2]}`;
}

export { findConfiguredRepo } from "./repos";

export type IssueAssignee = { id: string; name: string } | null | undefined;

/**
 * Why this ticket can't be started, or null to go ahead.
 *
 * Someone else's ticket is a hard stop, before anything is written. Not
 * squeamishness: the cost of being wrong is asymmetric. Starting your own ticket
 * twice is a no-op, whereas one transposed digit on a colleague's ticket pushes
 * a branch and opens a PR under their name's work, and nothing in this app
 * deletes either.
 *
 * A ticket already assigned to *you* is fine — that is the ordinary case of
 * picking up something you were given.
 */
export function assignmentRefusal(args: {
  identifier: string;
  assignee: IssueAssignee;
  viewerId: string;
}): string | null {
  const { identifier, assignee, viewerId } = args;
  if (!assignee) return null;
  if (assignee.id === viewerId) return null;
  return `${identifier} is assigned to ${assignee.name}. Reassign it in Linear first if you're taking it over.`;
}

/**
 * The PR title: a bracketed identifier, then the ticket's own title.
 *
 * The brackets are not decoration. `ticketIdsFromPR` reads a PR's ticket off its
 * title only in `[ENG-1234]` form — bare capitals-dash-digits would make "Fix
 * HTTP-2 handling" a ticket reference — and `stripTicketPrefix` then takes the
 * prefix back off for display. Write the title any other way and the PR this
 * feature creates is the one kind the dashboard can't link to its own ticket.
 *
 * Truncation therefore eats the title from the right and never the prefix.
 */
export function draftPRTitle(identifier: string, title: string): string {
  const full = `[${identifier}] ${title}`.trim();
  if (full.length <= MAX_PR_TITLE) return full;
  return `${full.slice(0, MAX_PR_TITLE - 1).trimEnd()}…`;
}

/**
 * The PR body. The Linear URL is spelled out rather than left to the branch
 * name: Linear's GitHub integration links on either, and the branch is the
 * fragile one — a rename would leave the PR orphaned from its ticket.
 */
export function draftPRBody(args: {
  identifier: string;
  url: string;
}): string {
  return [
    `Starting work on [${args.identifier}](${args.url}).`,
    "",
    "Opened as a draft from an empty commit, so the branch, the PR and the",
    "Linear link all exist before the first change. Mark it ready when it is.",
  ].join("\n");
}

/**
 * The message on the empty commit.
 *
 * An empty commit is not a formality — GitHub refuses to open a PR whose head
 * matches its base ("No commits between…"), so the branch needs exactly one
 * commit that changes nothing. Saying so in the message keeps the next person
 * from hunting for the diff.
 */
export function emptyCommitMessage(identifier: string): string {
  return [
    `chore: start ${identifier}`,
    "",
    "Empty commit. A pull request needs at least one commit that its base",
    "doesn't have; this is that commit and nothing more.",
  ].join("\n");
}

/** `type` and `position` are optional only because older fixtures lack them. */
export type WorkflowState = { id: string; name: string; type?: string; position?: number };

/**
 * Issue state types Linear considers "not begun". Only these are moved on.
 *
 * The list is the point: a ticket sitting in `started` (In Review, Blocked,
 * In Acceptance) or `completed` has already gone past In Progress, and pushing
 * it back there is a regression the person watching the board would have to
 * undo. "Start work" on such a ticket still opens the PR — it just leaves the
 * status where the team put it.
 */
const UNSTARTED_STATE_TYPES = new Set(["triage", "backlog", "unstarted"]);

export type IssueUpdatePlan = {
  /** Fields for Linear's `issueUpdate`. Empty object means there is nothing to write. */
  input: { assigneeId?: string; stateId?: string };
  assigned: boolean;
  statusMoved: boolean;
  /** Why a part of the update was skipped. Not errors — the normal cases. */
  notes: string[];
};

/** The first state Linear files under "started", in the team's own order. */
function firstStartedState(states: WorkflowState[]): WorkflowState | undefined {
  return states
    .filter((s) => s.type === "started")
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))[0];
}

/**
 * What to change on the Linear issue, given what it already says.
 *
 * Split out from the mutation so every "we chose not to" is testable, since each
 * one is a claim the UI then makes to the user.
 */
export function planIssueUpdate(args: {
  identifier: string;
  assignee: IssueAssignee;
  state: { id: string; name: string; type: string };
  viewerId: string;
  teamStates: WorkflowState[];
  inProgressStatusName: string;
}): IssueUpdatePlan {
  const {
    identifier,
    assignee,
    state,
    viewerId,
    teamStates,
    inProgressStatusName,
  } = args;

  const input: { assigneeId?: string; stateId?: string } = {};
  const notes: string[] = [];

  if (assignee?.id === viewerId) {
    notes.push(`${identifier} was already assigned to you.`);
  } else {
    input.assigneeId = viewerId;
  }

  const named = teamStates.find(
    (s) => s.name.toLowerCase() === inProgressStatusName.toLowerCase(),
  );
  // A team without a status by that name (Doing, WIP, In Development) still has
  // Linear's own "started" category, so the first started state in Linear's
  // order stands in, and the note says which one was used.
  const target = named ?? firstStartedState(teamStates);

  if (!target) {
    // A misconfigured status name is worth saying out loud once, here, rather
    // than silently never moving anything.
    notes.push(
      `No "${inProgressStatusName}" status on this team, so the ticket's status was left alone.`,
    );
  } else if (state.id === target.id) {
    notes.push(`${identifier} was already ${target.name}.`);
  } else if (!UNSTARTED_STATE_TYPES.has(state.type)) {
    notes.push(
      `${identifier} is already ${state.name}, so its status was left alone.`,
    );
  } else {
    input.stateId = target.id;
    if (!named) {
      notes.push(
        `No "${inProgressStatusName}" status on this team, so it was moved to ${target.name}, ` +
          `the first started status. Set linear.inProgressStatusName to choose another.`,
      );
    }
  }

  return {
    input,
    assigned: input.assigneeId !== undefined,
    statusMoved: input.stateId !== undefined,
    notes,
  };
}

/**
 * The one-line result under the form.
 *
 * "Opened" and "Found" are kept apart because they answer different questions.
 * A second run on the same ticket succeeding silently would read as though it
 * had made a second PR, which is the thing a person would then go and check.
 */
export function startWorkSummary(result: StartWorkResponse): string {
  if (!result.started || !result.pr) return result.error ?? "Nothing was started.";
  const ref = `${result.pr.repo}#${result.pr.number}`;
  const parts = [result.prCreated ? `Opened ${ref}` : `Found ${ref}`];
  if (result.assigned) parts.push("assigned to you");
  if (result.statusMoved) parts.push("status updated");
  return parts.join(" · ");
}

/**
 * Which repo the form should start on: the one last used, if it is still
 * configured, else the first.
 *
 * Validated rather than trusted, like `clampDockHeight` — a repo dropped from
 * config.json since the last run would otherwise leave the select showing a
 * value it has no option for, which renders as blank and posts a repo the server
 * will refuse.
 */
export function pickInitialRepo(
  stored: string | null | undefined,
  repos: RepoConfig[],
): string {
  const slugs = repos.map((r) => `${r.owner}/${r.name}`);
  if (stored && slugs.includes(stored)) return stored;
  return slugs[0] ?? "";
}
