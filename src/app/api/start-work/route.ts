import { NextResponse } from "next/server";
import { readConfig } from "@/lib/config";
import { isSameOrigin } from "@/lib/sessions";
import { isValidBranchName } from "@/lib/terminal";
import {
  branchExists,
  createEmptyBranch,
  fetchRepoBase,
  findOpenPRForBranch,
  openDraftPR,
} from "@/lib/githubWrite";
import { fetchStartWorkIssue, linearErrorMessage, updateIssue } from "@/lib/linearWrite";
import {
  DEFAULT_IN_PROGRESS_STATUS,
  assignmentRefusal,
  draftPRBody,
  draftPRTitle,
  emptyCommitMessage,
  findConfiguredRepo,
  parseTicketId,
  planIssueUpdate,
} from "@/lib/startWork";
import type { StartWorkResponse } from "@/types";

export const dynamic = "force-dynamic";

function refuse(error: string, status: number) {
  return NextResponse.json(
    {
      started: false,
      ticket: null,
      pr: null,
      prCreated: false,
      assigned: false,
      statusMoved: false,
      notes: [],
      error,
    } satisfies StartWorkResponse,
    { status },
  );
}

/**
 * Starts work on a Linear ticket: assign it, branch it, and open the empty draft
 * PR that makes it appear in "My PRs" — where the terminal button can pick it up.
 *
 * The first endpoint in Pitwall that writes to GitHub and Linear rather than
 * reading them. Everything else in this app is either read-only or acts on your
 * own machine, so the gates matter more here than anywhere else:
 *
 *  1. **POST only, same-origin.** Matching /api/terminal/kill. Pitwall listens on
 *     a predictable localhost port, and a GET would be reachable from any page's
 *     `<img>`.
 *  2. **Identifiers only.** `{ticketId, repo}`. The branch name comes from
 *     Linear, the base branch from GitHub, the owner and name from config.json.
 *     Nothing the browser sends names a ref or decides what is written.
 *  3. **A repo absent from config.json is refused,** so the reachable blast
 *     radius is the repos you already chose to watch.
 *  4. **Someone else's ticket is refused before any write.** Running this twice
 *     on your own ticket is a no-op; running it once on a colleague's would push
 *     a branch and open a PR that nothing here deletes.
 *
 * Order is deliberate: GitHub first, Linear second. The PR is the artefact worth
 * having and the one that can fail in interesting ways; the Linear writes are
 * cheap, and if they fail the PR still stands and re-running finishes the job.
 */
export async function POST(request: Request) {
  try {
    if (!isSameOrigin(request.headers.get("origin"), request.headers.get("host"))) {
      return refuse("Cross-origin requests are refused.", 403);
    }

    const githubToken = process.env.GITHUB_TOKEN;
    const linearKey = process.env.LINEAR_API_KEY;
    if (!githubToken) return refuse("GITHUB_TOKEN is not set in .env.local", 500);
    if (!linearKey) return refuse("LINEAR_API_KEY is not set in .env.local", 500);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return refuse("Expected a JSON body.", 400);
    }
    const { ticketId: rawTicketId, repo: rawRepo } = (body ?? {}) as {
      ticketId?: unknown;
      repo?: unknown;
    };
    if (typeof rawTicketId !== "string" || typeof rawRepo !== "string") {
      return refuse("Expected { ticketId, repo }.", 400);
    }

    const config = await readConfig();

    const identifier = parseTicketId(rawTicketId);
    if (!identifier) {
      return refuse(
        `"${rawTicketId}" isn't a Linear ticket id - try ${config.linear.teamKey}-1234.`,
        400,
      );
    }
    const repoConfig = findConfiguredRepo(config, rawRepo);
    if (!repoConfig) return refuse(`Repo is not in config.json: ${rawRepo}`, 400);
    const { owner, name } = repoConfig;
    const repo = `${owner}/${name}`;

    // --- Read Linear, and decide whether to go on at all ---------------------

    let issue, viewer;
    try {
      ({ issue, viewer } = await fetchStartWorkIssue(linearKey, identifier));
    } catch (err) {
      return refuse(linearErrorMessage(err, identifier), 502);
    }

    const refusal = assignmentRefusal({
      identifier: issue.identifier,
      assignee: issue.assignee,
      viewerId: viewer.id,
    });
    if (refusal) return refuse(refusal, 409);

    const branch = issue.branchName;
    // Linear builds this from the issue title, so it is not attacker-controlled
    // in any real sense — but it is the one string here that reaches a git ref,
    // and an unusable one should fail with its own name in the message.
    if (!branch || !isValidBranchName(branch)) {
      return refuse(`Linear gave an unusable branch name for ${identifier}: "${branch}"`, 502);
    }

    const ticket = {
      identifier: issue.identifier,
      title: issue.title,
      url: issue.url,
    };
    const notes: string[] = [];

    if (issue.team.key !== config.linear.teamKey) {
      notes.push(
        `${identifier} belongs to team ${issue.team.key}, not ${config.linear.teamKey}.`,
      );
    }

    // --- GitHub: branch, then PR ---------------------------------------------

    let pr = await findOpenPRForBranch(githubToken, owner, name, branch);
    let prCreated = false;

    if (pr) {
      notes.push(`${repo}#${pr.number} was already open on this branch.`);
    } else {
      const base = await fetchRepoBase(githubToken, owner, name);

      if (await branchExists(githubToken, owner, name, branch)) {
        // The branch survived a closed PR, or was pushed by hand. Reusing it is
        // right — creating a second one would strand whatever is on this.
        notes.push(`Branch ${branch} already existed, so it was reused.`);
      } else {
        await createEmptyBranch({
          token: githubToken,
          owner,
          name,
          branch,
          base,
          message: emptyCommitMessage(identifier),
        });
      }

      pr = await openDraftPR({
        token: githubToken,
        owner,
        name,
        title: draftPRTitle(identifier, issue.title),
        body: draftPRBody(ticket),
        head: branch,
        base: base.defaultBranch,
      });
      prCreated = true;
    }

    // --- Linear: assign and move status --------------------------------------

    const plan = planIssueUpdate({
      identifier: issue.identifier,
      assignee: issue.assignee,
      state: issue.state,
      viewerId: viewer.id,
      teamStates: issue.team.states.nodes,
      inProgressStatusName:
        config.linear.inProgressStatusName ?? DEFAULT_IN_PROGRESS_STATUS,
    });
    notes.push(...plan.notes);

    let { assigned, statusMoved } = plan;
    if (assigned || statusMoved) {
      try {
        if (!(await updateIssue(linearKey, issue.id, plan.input))) {
          throw new Error("Linear reported the update as unsuccessful.");
        }
      } catch (err) {
        // The PR exists, so this is not a failure of the request — but it is the
        // half the user can't see from GitHub, so it is said plainly.
        assigned = false;
        statusMoved = false;
        notes.push(
          `The PR is open, but updating ${identifier} in Linear failed: ${linearErrorMessage(err, identifier)}`,
        );
      }
    }

    return NextResponse.json({
      started: true,
      ticket,
      pr: { url: pr.url, number: pr.number, repo, branch },
      prCreated,
      assigned,
      statusMoved,
      notes,
    } satisfies StartWorkResponse);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return refuse(msg, 500);
  }
}
