/**
 * The GitHub calls that create things.
 *
 * REST rather than GraphQL, which the read side uses throughout. Opening a PR on
 * a branch that doesn't exist yet means creating a commit out of nothing, and
 * REST's git-database endpoints do that in two obvious posts. GraphQL's
 * `createCommitOnBranch` wants a branch that already exists and a file-changes
 * payload, so the same job there is a longer way round to a worse fit.
 *
 * Everything here is a write or a pre-flight check for one, kept apart from
 * `github.ts` so the read path stays read-only, with no mutation in reach.
 */

const GITHUB_REST = "https://api.github.com";

/** Matches the read path's budget; these are small calls that should never hang. */
const REQUEST_TIMEOUT_MS = 20_000;

export class GitHubRestError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "GitHubRestError";
    this.status = status;
  }
}

/**
 * GitHub's error bodies are `{message, errors:[{message|code}]}`. The nested
 * entries carry the useful half — "Reference already exists" arrives as a code
 * with the top-level message just saying "Reference update failed".
 */
export function restErrorMessage(status: number, body: unknown): string {
  const b = (body ?? {}) as {
    message?: unknown;
    errors?: Array<{ message?: unknown; code?: unknown }>;
  };
  const top = typeof b.message === "string" ? b.message : "";
  const nested = (b.errors ?? [])
    .map((e) => (typeof e.message === "string" ? e.message : String(e.code ?? "")))
    .filter(Boolean)
    .join("; ");
  const detail = [top, nested].filter(Boolean).join(" — ");
  return `GitHub API ${status}${detail ? `: ${detail}` : ""}`;
}

async function githubRest<T>(args: {
  token: string;
  method: "GET" | "POST";
  path: string;
  body?: unknown;
  /** Return null instead of throwing on a 404. For "does this exist" checks. */
  allow404?: boolean;
}): Promise<T | null> {
  const { token, method, path, body, allow404 } = args;
  const res = await fetch(`${GITHUB_REST}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      "User-Agent": "dev-dashboard",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (res.status === 404 && allow404) return null;

  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // A non-JSON body only ever appears on an error page; the status carries it.
  }

  if (!res.ok) throw new GitHubRestError(res.status, restErrorMessage(res.status, parsed));
  return parsed as T;
}

export type RepoBase = {
  defaultBranch: string;
  /** Head commit of the default branch. */
  sha: string;
  /** That commit's tree — reused verbatim, which is what makes the new commit empty. */
  treeSha: string;
};

/** The default branch and the commit to hang a new branch off. */
export async function fetchRepoBase(
  token: string,
  owner: string,
  name: string,
): Promise<RepoBase> {
  const repo = await githubRest<{ default_branch: string }>({
    token,
    method: "GET",
    path: `/repos/${owner}/${name}`,
  });
  const defaultBranch = repo?.default_branch;
  if (!defaultBranch) throw new Error(`Couldn't read the default branch of ${owner}/${name}.`);

  const commit = await githubRest<{ sha: string; commit: { tree: { sha: string } } }>({
    token,
    method: "GET",
    path: `/repos/${owner}/${name}/commits/${encodeURIComponent(defaultBranch)}`,
  });
  if (!commit?.sha) throw new Error(`Couldn't read the head of ${defaultBranch}.`);

  return { defaultBranch, sha: commit.sha, treeSha: commit.commit.tree.sha };
}

/** True when the branch already exists on the remote. */
export async function branchExists(
  token: string,
  owner: string,
  name: string,
  branch: string,
): Promise<boolean> {
  const ref = await githubRest<unknown>({
    token,
    method: "GET",
    // `/git/ref/heads/x` is an exact lookup; `/git/refs/heads/x` is a prefix
    // search that would report a hit for any branch starting with this name.
    path: `/repos/${owner}/${name}/git/ref/heads/${encodeURI(branch)}`,
    allow404: true,
  });
  return ref !== null;
}

export type ExistingPR = { number: number; url: string; branch: string };

/**
 * An open PR already on this branch, if there is one.
 *
 * The reason `start work` can be run twice without apologising: the second run
 * finds this and reports it instead of failing on a duplicate.
 */
export async function findOpenPRForBranch(
  token: string,
  owner: string,
  name: string,
  branch: string,
): Promise<ExistingPR | null> {
  const prs = await githubRest<Array<{ number: number; html_url: string }>>({
    token,
    method: "GET",
    path:
      `/repos/${owner}/${name}/pulls?state=open&head=` +
      encodeURIComponent(`${owner}:${branch}`),
  });
  const first = prs?.[0];
  return first ? { number: first.number, url: first.html_url, branch } : null;
}

/**
 * Creates `branch` at a new empty commit on top of the default branch.
 *
 * "Empty" means the new commit reuses its parent's tree, so it has a parent, a
 * message and no diff. GitHub needs it because a PR whose head is the same
 * commit as its base is refused outright.
 */
export async function createEmptyBranch(args: {
  token: string;
  owner: string;
  name: string;
  branch: string;
  base: RepoBase;
  message: string;
}): Promise<void> {
  const { token, owner, name, branch, base, message } = args;

  const commit = await githubRest<{ sha: string }>({
    token,
    method: "POST",
    path: `/repos/${owner}/${name}/git/commits`,
    body: { message, tree: base.treeSha, parents: [base.sha] },
  });
  if (!commit?.sha) throw new Error("GitHub accepted the commit but returned no sha.");

  await githubRest({
    token,
    method: "POST",
    path: `/repos/${owner}/${name}/git/refs`,
    body: { ref: `refs/heads/${branch}`, sha: commit.sha },
  });
}

/** Opens a draft PR and returns it. */
export async function openDraftPR(args: {
  token: string;
  owner: string;
  name: string;
  title: string;
  body: string;
  head: string;
  base: string;
}): Promise<ExistingPR> {
  const { token, owner, name, title, body, head, base } = args;
  const pr = await githubRest<{ number: number; html_url: string }>({
    token,
    method: "POST",
    path: `/repos/${owner}/${name}/pulls`,
    body: { title, body, head, base, draft: true },
  });
  if (!pr?.number) throw new Error("GitHub accepted the pull request but returned no number.");
  return { number: pr.number, url: pr.html_url, branch: head };
}
