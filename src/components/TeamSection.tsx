"use client";

import { countEmphasisClass, formatFlowCount, toReviewCount } from "@/lib/view";
import type { GitHubResponse, LinearResponse, StatusFlow } from "@/types";

type Props = {
  github?: GitHubResponse;
  githubError?: string;
  linear?: LinearResponse;
  linearError?: string;
  teamKey: string;
  hotspotThreshold: number;
};

export default function TeamSection({
  github,
  githubError,
  linear,
  linearError,
  hotspotThreshold,
}: Props) {
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      {/* The subtitle names both exclusions because the column is a remainder:
          say only "excludes WIP" and the arithmetic stops reconciling against
          Total the moment a repo has an approved PR. */}
      <Panel title="Open PRs" subtitle="to review · excludes WIP and approved">
        {githubError && <ErrorMsg msg={githubError} />}
        {!githubError && !github && <Skeleton />}
        {!githubError && github && github.unavailableRepos.length > 0 && (
          <p className="mb-2 text-xs text-accent-yellow">
            Couldn&apos;t read {github.unavailableRepos.join(", ")}. Check the name in
            config.json, and that your token can see it.
          </p>
        )}
        {!githubError && github && (() => {
          const rows = github.teamPRsByRepo
            .filter((r) => r.openCount > 0)
            .map((r) => ({
              ...r,
              toReview: toReviewCount(r.openCount, r.wipCount, r.approvedCount),
            }))
            .sort((a, b) => b.toReview - a.toReview || b.openCount - a.openCount);
          if (rows.length === 0) {
            return (
              <p className="text-sm text-text-muted">
                No open PRs across configured repos.
              </p>
            );
          }
          return (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-text-dim">
                  <th className="pb-2 font-medium">Repo</th>
                  <th className="pb-2 text-right font-medium">To Review</th>
                  <th className="pb-2 text-right font-medium">Approved</th>
                  <th className="pb-2 text-right font-medium">WIP</th>
                  <th className="pb-2 text-right font-medium">Total</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const repoName = row.repo.split("/")[1] ?? row.repo;
                  // Link to all open PRs (WIP included) so the target matches the Total column.
                  const repoHref = `https://github.com/${row.repo}/pulls`;
                  return (
                    <tr key={row.repo} className="border-t border-line">
                      <td className="py-2">
                        <a
                          href={repoHref}
                          target="_blank"
                          rel="noreferrer"
                          className="hover:text-accent-blue hover:underline"
                        >
                          {repoName}
                        </a>
                      </td>
                      <td
                        className={`py-2 text-right font-mono ${countEmphasisClass(row.toReview, hotspotThreshold)}`}
                      >
                        {row.toReview}
                      </td>
                      {/* Green, not muted: an approved PR is the one row state
                          that is good news and worth spotting from across the
                          table. Dash when zero, matching the WIP column. */}
                      <td className="py-2 text-right font-mono text-accent-green">
                        {row.approvedCount || "—"}
                      </td>
                      <td className="py-2 text-right font-mono text-text-muted">
                        {row.wipCount || "—"}
                      </td>
                      <td className="py-2 text-right font-mono text-text-dim">
                        {row.openCount}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          );
        })()}
      </Panel>

      <Panel title="Linear Flow" subtitle="in flight, across the team">
        {linearError && <ErrorMsg msg={linearError} />}
        {!linearError && !linear && <Skeleton />}
        {!linearError && linear && linear.statusFlow.length === 0 && (
          <p className="text-sm text-text-muted">
            No in-flight statuses on {linear.teamKey}. Linear reports none of its
            workflow states as started.
          </p>
        )}
        {!linearError && linear && linear.statusFlow.length > 0 && (
          // Three across rather than two: the statuses come from Linear now, so
          // there are as many cards as the team has in-flight states — six today
          // where the old hardcoded pair fitted a two-column grid.
          <div className="grid grid-cols-2 gap-3 xl:grid-cols-3">
            {linear.statusFlow.map((s) => (
              <StatusCard
                key={s.id}
                status={s}
                showPoints={linear.estimatesEnabled}
                hotspotThreshold={hotspotThreshold}
                href={`https://linear.app/${linear.orgUrlKey}/team/${linear.teamKey}/active`}
              />
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}

/**
 * One in-flight Linear status and its load.
 *
 * The dot carries Linear's own colour for the status, which is what makes six
 * of these scannable where six identical cards would not be — you recognise
 * "Blocked" by its red before reading the label, exactly as in Linear.
 */
function StatusCard({
  status,
  href,
  showPoints,
  hotspotThreshold,
}: {
  status: StatusFlow;
  href: string;
  hotspotThreshold: number;
  /** False for a team that doesn't estimate, where every total would read 0. */
  showPoints: boolean;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      // Every card lands on the team's active view, not a view filtered to this
      // status: Linear has no documented, stable URL parameter for filtering an
      // existing view by workflow state. The title says so rather than letting
      // the destination imply a filter that isn't applied.
      title={`${status.name}: ${formatFlowCount(status.count, status.truncated)} tickets${showPoints ? `, ${status.points} points` : ""} - opens the team's active view in Linear`}
      className="block rounded-md border border-line bg-bg-row p-4 transition-ui hover:border-accent-blue/50"
    >
      <div className="flex items-center gap-1.5">
        <span
          aria-hidden
          className="size-2 shrink-0 rounded-full"
          // Linear returns a hex string, so this can't be a Tailwind class.
          style={{ backgroundColor: status.color }}
        />
        <span className="truncate text-xs uppercase tracking-wide text-text-muted">
          {status.name}
        </span>
      </div>
      <div className="mt-1 flex items-baseline gap-1.5">
        <span
          className={`font-mono text-3xl font-semibold ${countEmphasisClass(status.count, hotspotThreshold)}`}
        >
          {formatFlowCount(status.count, status.truncated)}
        </span>
        <span className="text-xs text-text-muted">tickets</span>
      </div>
      {showPoints && (
        <div className="mt-1 text-xs text-text-dim">
          <span className="font-mono text-text-muted">{status.points}</span> points
        </div>
      )}
    </a>
  );
}

function Panel({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-line bg-bg-panel p-5">
      <div className="mb-5 flex items-baseline justify-between">
        <h2 className="text-base font-semibold">{title}</h2>
        {subtitle && <span className="text-xs text-text-muted">{subtitle}</span>}
      </div>
      {children}
    </div>
  );
}

function ErrorMsg({ msg }: { msg: string }) {
  return (
    <p className="rounded-sm border border-accent-red/30 bg-accent-red/10 p-3 text-sm text-accent-red">
      {msg}
    </p>
  );
}

function Skeleton() {
  return (
    <div className="space-y-2">
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-8 animate-pulse rounded-sm bg-bg-row" />
      ))}
    </div>
  );
}
