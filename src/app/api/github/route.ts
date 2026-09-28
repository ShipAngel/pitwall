import { NextResponse } from "next/server";
import { readConfig } from "@/lib/config";
import {
  sortByOldestFirst,
  toCIState,
  toMergeQueue,
  toMergeStateStatus,
} from "@/lib/view";
import {
  buildGitHubQueries,
  configuredRepoFilter,
  DEFAULT_WIP_LABEL,
  fetchGitHubData,
  getRepoOpenCount,
  getRepoApprovedCount,
  getRepoWipCount,
  type GitHubPRNode,
  unavailableRepos,
} from "@/lib/github";
import type {
  GitHubResponse,
  MyPR,
  ReviewRequestPR,
  TeamRepoPRs,
} from "@/types";

export const dynamic = "force-dynamic";

/**
 * Search returns a mixed Issue/PullRequest union, and a node the token can't
 * fully resolve comes back as null rather than as an error — so anything without
 * a number is dropped instead of crashing the panel.
 */
function isPRNode(n: GitHubPRNode | null | undefined): n is GitHubPRNode {
  return n != null && typeof n.number === "number";
}

export async function GET() {
  try {
    const token = process.env.GITHUB_TOKEN;
    if (!token) {
      return NextResponse.json(
        { error: "GITHUB_TOKEN is not set in .env.local" },
        { status: 500 },
      );
    }

    const config = await readConfig();
    const wipLabel = config.wipLabel ?? DEFAULT_WIP_LABEL;
    // Several queries in parallel, not one: GitHub kills a query still running
    // at ~10s and answers with nginx's 502, and everything this panel needs in
    // one query measured 12.6s. See buildGitHubQueries.
    const data = await fetchGitHubData(
      token,
      buildGitHubQueries(config.repos, wipLabel),
    );

    const wipLabelLower = wipLabel.toLowerCase();
    const isWip = (n: GitHubPRNode) =>
      (n.labels?.nodes ?? []).some((l) => l.name.toLowerCase() === wipLabelLower);

    // Both searches already carry `repo:` qualifiers, so this normally drops
    // nothing. It is here for the case the qualifiers can't cover: with no repos
    // configured the scope string is empty and the search is unrestricted.
    const isConfigured = configuredRepoFilter(config.repos);
    const inScope = (n: GitHubPRNode) =>
      isConfigured(n.repository.nameWithOwner);

    const myPRs: MyPR[] = data.myOpenPRs.nodes
      .filter(isPRNode)
      .filter(inScope)
      .map((n) => ({
        repo: n.repository.nameWithOwner,
        url: n.url,
        title: n.title,
        number: n.number,
        isDraft: n.isDraft,
        reviewDecision: n.reviewDecision,
        createdAt: n.createdAt,
        isWip: isWip(n),
        headRefName: n.headRefName ?? "",
        isCrossRepository: n.isCrossRepository === true,
        mergeStateStatus: toMergeStateStatus(n.mergeStateStatus),
        mergeQueue: toMergeQueue(n.isInMergeQueue, n.mergeQueueEntry),
        ciState: toCIState(
          n.commits?.nodes[0]?.commit?.statusCheckRollup?.state,
          n.commits?.nodes[0]?.commit?.statusCheckRollup?.contexts,
          n.commits?.nodes[0]?.commit?.checkSuites,
        ),
      }));

    const reviewRequestNodes = (data.reviewRequests?.nodes ?? []).filter(isPRNode);
    const scopedReviewRequestNodes = reviewRequestNodes.filter(inScope);

    const reviewRequests: ReviewRequestPR[] = sortByOldestFirst(
      scopedReviewRequestNodes.map((n) => ({
        repo: n.repository.nameWithOwner,
        url: n.url,
        title: n.title,
        number: n.number,
        isDraft: n.isDraft,
        reviewDecision: n.reviewDecision,
        createdAt: n.createdAt,
        isWip: isWip(n),
        headRefName: n.headRefName ?? "",
        ciState: toCIState(
          n.commits?.nodes[0]?.commit?.statusCheckRollup?.state,
          n.commits?.nodes[0]?.commit?.statusCheckRollup?.contexts,
          n.commits?.nodes[0]?.commit?.checkSuites,
        ),
        author: n.author?.login ?? "",
        additions: n.additions ?? 0,
        deletions: n.deletions ?? 0,
      })),
    );

    // `issueCount` counts what the *search* matched, so it only describes this
    // list while the search did all the scoping. If the repo filter above also
    // removed something, the count includes rows we're not showing and rows past
    // the page cap we can't inspect — so the only defensible total is the one we
    // actually hold.
    const reviewRequestTotal =
      scopedReviewRequestNodes.length === reviewRequestNodes.length
        ? (data.reviewRequests?.issueCount ?? reviewRequests.length)
        : reviewRequests.length;

    const teamPRsByRepo: TeamRepoPRs[] = config.repos.map((r) => ({
      repo: `${r.owner}/${r.name}`,
      openCount: getRepoOpenCount(data, r.owner, r.name),
      wipCount: getRepoWipCount(data, r.owner, r.name),
      approvedCount: getRepoApprovedCount(data, r.owner, r.name),
    }));

    const response: GitHubResponse = {
      viewer: data.viewer.login,
      myPRs,
      reviewRequests,
      reviewRequestTotal,
      teamPRsByRepo,
      unavailableRepos: unavailableRepos(data, config.repos),
      wipLabel,
    };
    return NextResponse.json(response);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
