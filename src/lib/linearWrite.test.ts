import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LINEAR_ISSUE_UPDATE_MUTATION,
  LINEAR_START_WORK_QUERY,
  fetchStartWorkIssue,
  linearErrorMessage,
  updateIssue,
} from "./linearWrite";

function stubFetch(body: unknown, ok = true, status = 200) {
  const calls: Array<{ query: string; variables: unknown }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: { body: string }) => {
      const parsed = JSON.parse(init.body);
      calls.push({ query: parsed.query, variables: parsed.variables });
      return {
        ok,
        status,
        json: async () => body,
        text: async () => JSON.stringify(body),
      };
    }),
  );
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("LINEAR_START_WORK_QUERY", () => {
  it("asks for everything the flow needs in one round trip", () => {
    // Viewer for the ownership check, branchName for the ref, assignee and state
    // for the guards, team states so the status move resolves without a second
    // query.
    for (const field of ["viewer", "branchName", "assignee", "state", "states"]) {
      expect(LINEAR_START_WORK_QUERY).toContain(field);
    }
  });

  it("takes the identifier as a String, which is what accepts 'ENG-1234'", () => {
    expect(LINEAR_START_WORK_QUERY).toContain("$id: String!");
  });
});

describe("fetchStartWorkIssue", () => {
  it("sends the identifier as the id variable", async () => {
    const calls = stubFetch({ data: { viewer: { id: "v" }, issue: { identifier: "ENG-1" } } });
    await fetchStartWorkIssue("key", "ENG-1");
    expect(calls[0].variables).toEqual({ id: "ENG-1" });
    expect(calls[0].query).toBe(LINEAR_START_WORK_QUERY);
  });

  it("throws when Linear reports the issue is missing", async () => {
    stubFetch({ errors: [{ message: "Entity not found: Issue" }] });
    await expect(fetchStartWorkIssue("key", "ENG-9")).rejects.toThrow(/Linear GraphQL errors/);
  });
});

describe("linearErrorMessage", () => {
  // Linear's own sentence for a bad id, which is far better than the JSON dump
  // fetchLinearGraphQL throws around it.
  it("turns a not-found into a sentence naming the ticket", () => {
    const err = new Error(
      'Linear GraphQL errors: [{"message":"Entity not found: Issue","extensions":{"userPresentableMessage":"Could not find referenced Issue."}}]',
    );
    expect(linearErrorMessage(err, "ENG-9")).toBe("No Linear issue ENG-9.");
  });

  it("passes through another user-presentable message unchanged", () => {
    const err = new Error('x {"userPresentableMessage":"You do not have access to this team."} y');
    expect(linearErrorMessage(err, "ENG-1")).toBe("You do not have access to this team.");
  });

  it("falls back to the raw message when there is nothing presentable", () => {
    expect(linearErrorMessage(new Error("Linear API 500: down"), "ENG-1")).toBe(
      "Linear API 500: down",
    );
  });

  it("handles a thrown non-Error", () => {
    expect(linearErrorMessage("just a string", "ENG-1")).toBe("just a string");
  });
});

describe("updateIssue", () => {
  it("sends the issue id and the input", async () => {
    const calls = stubFetch({ data: { issueUpdate: { success: true } } });
    await expect(updateIssue("key", "uuid-1", { assigneeId: "me" })).resolves.toBe(true);
    expect(calls[0].query).toBe(LINEAR_ISSUE_UPDATE_MUTATION);
    expect(calls[0].variables).toEqual({ id: "uuid-1", input: { assigneeId: "me" } });
  });

  it("sets assignee and state in one mutation", async () => {
    const calls = stubFetch({ data: { issueUpdate: { success: true } } });
    await updateIssue("key", "uuid-1", { assigneeId: "me", stateId: "s" });
    expect(calls[0].variables).toEqual({
      id: "uuid-1",
      input: { assigneeId: "me", stateId: "s" },
    });
  });

  // Linear answers a field it won't let you set with success:false rather than an
  // error, so the boolean has to be read rather than assumed from the 200.
  it("reports false when Linear accepts the call but doesn't apply it", async () => {
    stubFetch({ data: { issueUpdate: { success: false } } });
    await expect(updateIssue("key", "uuid-1", { assigneeId: "me" })).resolves.toBe(false);
  });

  it("reports false when the payload is missing entirely", async () => {
    stubFetch({ data: {} });
    await expect(updateIssue("key", "uuid-1", {})).resolves.toBe(false);
  });
});
