import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GitHubRestError,
  branchExists,
  createEmptyBranch,
  fetchRepoBase,
  findOpenPRForBranch,
  openDraftPR,
  restErrorMessage,
} from "./githubWrite";

type Call = { url: string; method: string; body: unknown; headers: Record<string, string> };

/**
 * Replies to each request in order. Every entry is `{status, body}` so a test can
 * put a 404 in the middle — which is the normal answer here, not an error.
 */
function stubFetch(replies: Array<{ status?: number; body?: unknown }>) {
  const calls: Call[] = [];
  let i = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { method: string; body?: string; headers: Record<string, string> }) => {
      calls.push({
        url,
        method: init.method,
        body: init.body ? JSON.parse(init.body) : undefined,
        headers: init.headers,
      });
      const reply = replies[i++] ?? { status: 500, body: { message: "no stub" } };
      const status = reply.status ?? 200;
      return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => (reply.body === undefined ? "" : JSON.stringify(reply.body)),
      };
    }),
  );
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("restErrorMessage", () => {
  it("includes the status and top-level message", () => {
    expect(restErrorMessage(422, { message: "Validation Failed" })).toBe(
      "GitHub API 422: Validation Failed",
    );
  });

  // The useful half of a ref conflict is in `errors`, not `message` — GitHub's
  // top-level text is only ever "Reference update failed".
  it("appends the nested error messages", () => {
    const msg = restErrorMessage(422, {
      message: "Reference update failed",
      errors: [{ message: "Reference already exists" }],
    });
    expect(msg).toContain("Reference update failed");
    expect(msg).toContain("Reference already exists");
  });

  it("falls back to an error's code when it has no message", () => {
    expect(restErrorMessage(422, { message: "Bad", errors: [{ code: "already_exists" }] })).toContain(
      "already_exists",
    );
  });

  it("survives a body that isn't GitHub's shape", () => {
    expect(restErrorMessage(500, null)).toBe("GitHub API 500");
    expect(restErrorMessage(502, "<html>")).toBe("GitHub API 502");
  });
});

describe("fetchRepoBase", () => {
  it("reads the default branch, its head sha and that commit's tree", async () => {
    const calls = stubFetch([
      { body: { default_branch: "main" } },
      { body: { sha: "head-sha", commit: { tree: { sha: "tree-sha" } } } },
    ]);
    const base = await fetchRepoBase("t", "Acme", "alpha");
    expect(base).toEqual({ defaultBranch: "main", sha: "head-sha", treeSha: "tree-sha" });
    expect(calls[0].url).toContain("/repos/Acme/alpha");
    expect(calls[1].url).toContain("/repos/Acme/alpha/commits/main");
  });

  it("sends the bearer token and the API version", async () => {
    const calls = stubFetch([
      { body: { default_branch: "main" } },
      { body: { sha: "s", commit: { tree: { sha: "t" } } } },
    ]);
    await fetchRepoBase("gh-token", "Acme", "alpha");
    expect(calls[0].headers.Authorization).toBe("Bearer gh-token");
    expect(calls[0].headers["X-GitHub-Api-Version"]).toBe("2022-11-28");
  });

  it("throws a GitHubRestError carrying the status", async () => {
    stubFetch([{ status: 404, body: { message: "Not Found" } }]);
    await expect(fetchRepoBase("t", "Acme", "missing")).rejects.toThrow(GitHubRestError);
  });

  it("encodes a default branch name containing a slash", async () => {
    const calls = stubFetch([
      { body: { default_branch: "release/v2" } },
      { body: { sha: "s", commit: { tree: { sha: "t" } } } },
    ]);
    await fetchRepoBase("t", "Acme", "alpha");
    expect(calls[1].url).toContain("release%2Fv2");
  });
});

describe("branchExists", () => {
  it("is true when the ref resolves", async () => {
    stubFetch([{ body: { ref: "refs/heads/x" } }]);
    await expect(branchExists("t", "Acme", "alpha", "x")).resolves.toBe(true);
  });

  it("is false on a 404 rather than throwing", async () => {
    stubFetch([{ status: 404, body: { message: "Not Found" } }]);
    await expect(branchExists("t", "Acme", "alpha", "x")).resolves.toBe(false);
  });

  // /git/refs/heads/x is a *prefix* search: it answers yes for "x-2" when only
  // "x-2" exists. /git/ref/heads/x is the exact lookup this needs.
  it("uses the exact ref endpoint, not the prefix-matching one", async () => {
    const calls = stubFetch([{ status: 404 }]);
    await branchExists("t", "Acme", "alpha", "feature");
    expect(calls[0].url).toContain("/git/ref/heads/feature");
    expect(calls[0].url).not.toContain("/git/refs/heads/");
  });

  it("still throws on a real failure", async () => {
    stubFetch([{ status: 500, body: { message: "boom" } }]);
    await expect(branchExists("t", "Acme", "alpha", "x")).rejects.toThrow(/GitHub API 500/);
  });
});

describe("findOpenPRForBranch", () => {
  it("returns the open PR on that branch", async () => {
    stubFetch([{ body: [{ number: 12, html_url: "https://gh/pr/12" }] }]);
    await expect(findOpenPRForBranch("t", "Acme", "alpha", "b")).resolves.toEqual({
      number: 12,
      url: "https://gh/pr/12",
      branch: "b",
    });
  });

  it("returns null when there is none", async () => {
    stubFetch([{ body: [] }]);
    await expect(findOpenPRForBranch("t", "Acme", "alpha", "b")).resolves.toBeNull();
  });

  it("qualifies the head with the owner, so another fork's branch can't match", async () => {
    const calls = stubFetch([{ body: [] }]);
    await findOpenPRForBranch("t", "Acme", "alpha", "feature/x");
    expect(decodeURIComponent(calls[0].url)).toContain("head=Acme:feature/x");
    expect(calls[0].url).toContain("state=open");
  });
});

describe("createEmptyBranch", () => {
  const base = { defaultBranch: "main", sha: "base-sha", treeSha: "base-tree" };

  it("commits the base tree unchanged, then points the branch at it", async () => {
    const calls = stubFetch([{ body: { sha: "new-sha" } }, { body: { ref: "ok" } }]);
    await createEmptyBranch({
      token: "t",
      owner: "Acme",
      name: "alpha",
      branch: "feature",
      base,
      message: "chore: start",
    });

    // Reusing the parent's tree is exactly what makes the commit empty; a
    // different tree here would put a diff on the PR.
    expect(calls[0].body).toEqual({
      message: "chore: start",
      tree: "base-tree",
      parents: ["base-sha"],
    });
    expect(calls[1].body).toEqual({ ref: "refs/heads/feature", sha: "new-sha" });
  });

  it("creates the commit before the ref", async () => {
    const calls = stubFetch([{ body: { sha: "new-sha" } }, { body: {} }]);
    await createEmptyBranch({
      token: "t", owner: "Acme", name: "alpha", branch: "f", base, message: "m",
    });
    expect(calls[0].url).toContain("/git/commits");
    expect(calls[1].url).toContain("/git/refs");
  });

  it("does not create a ref when the commit fails", async () => {
    const calls = stubFetch([{ status: 422, body: { message: "bad tree" } }]);
    await expect(
      createEmptyBranch({
        token: "t", owner: "Acme", name: "alpha", branch: "f", base, message: "m",
      }),
    ).rejects.toThrow(/GitHub API 422/);
    expect(calls).toHaveLength(1);
  });

  it("refuses a commit response with no sha rather than creating a bad ref", async () => {
    const calls = stubFetch([{ body: {} }]);
    await expect(
      createEmptyBranch({
        token: "t", owner: "Acme", name: "alpha", branch: "f", base, message: "m",
      }),
    ).rejects.toThrow(/no sha/);
    expect(calls).toHaveLength(1);
  });
});

describe("openDraftPR", () => {
  it("opens the PR as a draft", async () => {
    const calls = stubFetch([{ body: { number: 5, html_url: "https://gh/pr/5" } }]);
    const pr = await openDraftPR({
      token: "t",
      owner: "Acme",
      name: "alpha",
      title: "[ENG-1] Thing",
      body: "b",
      head: "feature",
      base: "main",
    });
    expect(pr).toEqual({ number: 5, url: "https://gh/pr/5", branch: "feature" });
    expect(calls[0].body).toEqual({
      title: "[ENG-1] Thing",
      body: "b",
      head: "feature",
      base: "main",
      draft: true,
    });
  });

  it("surfaces GitHub's refusal to open a PR with no commits", async () => {
    stubFetch([
      {
        status: 422,
        body: {
          message: "Validation Failed",
          errors: [{ message: "No commits between main and feature" }],
        },
      },
    ]);
    await expect(
      openDraftPR({
        token: "t", owner: "Acme", name: "alpha", title: "t", body: "b", head: "feature", base: "main",
      }),
    ).rejects.toThrow(/No commits between/);
  });
});
