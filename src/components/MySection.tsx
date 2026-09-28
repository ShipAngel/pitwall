"use client";

import type { GitHubResponse, LinearResponse, MyPR, RepoConfig } from "@/types";
import { filterPRsToConfiguredRepos, groupPRsByRepo } from "@/lib/grouping";
import { linkingContext, summarizeMyPRs, summarizeMyTickets } from "@/lib/view";
import CopyAllButton from "./CopyAllButton";
import PRTable from "./PRTable";
import TicketTable from "./TicketTable";

type Props = {
  repos: RepoConfig[];
  github?: GitHubResponse;
  githubError?: string;
  linear?: LinearResponse;
  linearError?: string;
  /** Absent when terminals are disabled. Forwarded to the PR rows. */
  onOpenTerminal?: (pr: MyPR) => void;
};

export default function MySection({
  repos,
  github,
  githubError,
  linear,
  linearError,
  onOpenTerminal,
}: Props) {
  const inScopePRs = github
    ? filterPRsToConfiguredRepos(github.myPRs, repos)
    : [];
  const grouped = github ? groupPRsByRepo(github.myPRs, repos) : [];

  const { ticketIndex, orgUrlKey, ticketKeys } = linkingContext(linear);

  // Stacked, not side by side: both tables now carry ticket/PR cross-links and
  // nested families, and at half width that truncated the very titles they exist
  // to show.
  return (
    <div className="grid gap-6">
      <Panel
        title="My PRs"
        subtitle={!githubError && github ? summarizeMyPRs(inScopePRs) : undefined}
        action={!githubError && github && <CopyAllButton prs={inScopePRs} />}
      >
        {githubError && <ErrorMsg msg={githubError} />}
        {!githubError && !github && <Skeleton />}
        {!githubError && github && (
          <PRTable
            groups={grouped}
            ticketIndex={ticketIndex}
            ticketKeys={ticketKeys}
            orgUrlKey={orgUrlKey}
            onOpenTerminal={onOpenTerminal}
          />
        )}
      </Panel>

      <Panel
        title="My Tickets"
        subtitle={
          !linearError && linear
            ? summarizeMyTickets(
                linear.myTickets.length,
                linear.cyclePoints.find((c) => c.isCurrent)?.number ?? null,
              )
            : undefined
        }
      >
        {linearError && <ErrorMsg msg={linearError} />}
        {!linearError && !linear && <Skeleton />}
        {!linearError && linear && <TicketTable
            tickets={linear.myTickets}
            orgUrlKey={orgUrlKey}
            teamsWithoutCycles={linear.cyclesEnabled ? [] : [linear.teamKey]}
          />}
      </Panel>
    </div>
  );
}

/** A titled card. The subtitle is suppressed while its source is erroring. */
function Panel({
  title,
  subtitle,
  action,
  children,
}: {
  title: string;
  subtitle?: string | false;
  /** Optional control for the panel as a whole, right-aligned in the header. */
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-line bg-bg-panel p-5">
      <div className="mb-5 flex items-baseline justify-between">
        {/* h2 rather than h3: the Me tab dropped its section headings, so these
            cards sit directly under the page title and an h3 would skip a
            level. The Team tab's panels stay h3 under their real h2s. */}
        <h2 className="text-base font-semibold">{title}</h2>
        <span className="flex items-center gap-2">
          {subtitle && (
            <span className="text-xs text-text-muted">{subtitle}</span>
          )}
          {action}
        </span>
      </div>
      {children}
    </div>
  );
}

function ErrorMsg({ msg }: { msg: string }) {
  return (
    <p className="rounded border border-accent-red/30 bg-accent-red/10 p-3 text-sm text-accent-red">
      {msg}
    </p>
  );
}

function Skeleton() {
  return (
    <div className="space-y-2">
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-8 animate-pulse rounded bg-bg-row" />
      ))}
    </div>
  );
}
