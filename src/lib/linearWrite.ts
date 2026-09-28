import { fetchLinearGraphQL } from "./linear";

/**
 * Reading a single issue, and writing back to it.
 *
 * Apart from `linear.ts` for the same reason `githubWrite.ts` is apart from
 * `github.ts`: the dashboard's Linear query is a read of everything assigned to
 * you, and the one mutation in this app has no business sharing a module with
 * it.
 */

/**
 * Everything "start work" needs, in one round trip: who you are, what the ticket
 * says, and the team's workflow states so the status move can be resolved to an
 * id without a second query.
 *
 * `issue(id:)` takes the human identifier ("ENG-5800") as well as the UUID,
 * which is what lets the UI accept what you'd paste.
 */
export const LINEAR_START_WORK_QUERY = `
  query LinearStartWork($id: String!) {
    viewer { id name }
    issue(id: $id) {
      id
      identifier
      title
      url
      # Linear generates this per viewer, already prefixed with your name —
      # so the branch matches what Linear's own "copy branch name" would give
      # you, and its GitHub integration links the PR without being told to.
      branchName
      assignee { id name }
      state { id name type }
      team {
        key
        states(first: 100) { nodes { id name type position } }
      }
    }
  }
`;

export const LINEAR_ISSUE_UPDATE_MUTATION = `
  mutation LinearIssueUpdate($id: String!, $input: IssueUpdateInput!) {
    issueUpdate(id: $id, input: $input) {
      success
      issue { id }
    }
  }
`;

export type StartWorkIssue = {
  id: string;
  identifier: string;
  title: string;
  url: string;
  branchName: string;
  assignee: { id: string; name: string } | null;
  state: { id: string; name: string; type: string };
  team: {
    key: string;
    states: { nodes: Array<{ id: string; name: string; type?: string; position?: number }> };
  };
};

export type RawStartWorkResponse = {
  viewer: { id: string; name: string };
  issue: StartWorkIssue;
};

/**
 * Pulls the identifier out of Linear's error shape.
 *
 * Linear returns a genuinely user-facing sentence for a bad id
 * ("Could not find referenced Issue.") in `userPresentableMessage`. Surfacing
 * that beats the JSON dump `fetchLinearGraphQL` would otherwise throw, which is
 * the difference between a typo being obvious and looking like an outage.
 */
export function linearErrorMessage(err: unknown, identifier: string): string {
  const raw = err instanceof Error ? err.message : String(err);
  const presentable = /"userPresentableMessage":"([^"]+)"/.exec(raw);
  if (presentable) {
    return /not find|not found/i.test(presentable[1])
      ? `No Linear issue ${identifier}.`
      : presentable[1];
  }
  return raw;
}

export async function fetchStartWorkIssue(
  apiKey: string,
  identifier: string,
): Promise<RawStartWorkResponse> {
  return fetchLinearGraphQL<RawStartWorkResponse>(apiKey, LINEAR_START_WORK_QUERY, {
    id: identifier,
  });
}

/**
 * Applies an `issueUpdate`. Returns false when Linear accepts the call but
 * reports no success, which it does rather than erroring for a field it won't
 * let you set.
 */
export async function updateIssue(
  apiKey: string,
  issueId: string,
  input: Record<string, unknown>,
): Promise<boolean> {
  const data = await fetchLinearGraphQL<{ issueUpdate: { success: boolean } }>(
    apiKey,
    LINEAR_ISSUE_UPDATE_MUTATION,
    { id: issueId, input },
  );
  return data.issueUpdate?.success === true;
}
