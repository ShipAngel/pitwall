"use client";

import type { GitHubResponse, LinearResponse } from "@/types";
import { linkingContext, summarizeReviewRequests } from "@/lib/view";
import CopyAllButton from "./CopyAllButton";
import ReviewRequestTable from "./ReviewRequestTable";

type Props = {
  github?: GitHubResponse;
  githubError?: string;
  linear?: LinearResponse;
};

/**
 * Split out of MySection and placed above everything else on the Cockpit tab —
 * these are PRs blocking someone else on you, so they outrank both your own
 * PRs and the local sessions/Start Work row for attention.
 */
export default function ReviewRequestsSection({
  github,
  githubError,
  linear,
}: Props) {
  const { ticketIndex, orgUrlKey, ticketKeys } = linkingContext(linear);

  return (
    <div className="rounded-lg border border-line bg-bg-panel p-5">
      <div className="mb-5 flex items-baseline justify-between">
        <h2 className="text-base font-semibold">Awaiting My Review</h2>
        <span className="flex items-center gap-2">
          {!githubError && github && (
            <span className="text-xs text-text-muted">
              {summarizeReviewRequests(github.reviewRequests, github.reviewRequestTotal)}
            </span>
          )}
          {!githubError && github && <CopyAllButton prs={github.reviewRequests} />}
        </span>
      </div>

      {githubError && (
        <p className="rounded-sm border border-accent-red/30 bg-accent-red/10 p-3 text-sm text-accent-red">
          {githubError}
        </p>
      )}
      {!githubError && !github && (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-8 animate-pulse rounded-sm bg-bg-row" />
          ))}
        </div>
      )}
      {!githubError && github && (
        <ReviewRequestTable
          prs={github.reviewRequests}
          ticketIndex={ticketIndex}
          ticketKeys={ticketKeys}
          orgUrlKey={orgUrlKey}
        />
      )}
    </div>
  );
}
