"use client";

import { useState } from "react";
import { useRememberedRepo } from "@/hooks/useRememberedRepo";
import { useStartWork } from "@/hooks/useStartWork";
import { parseTicketId, startWorkSummary } from "@/lib/startWork";
import type { RepoConfig } from "@/types";

/** Ties the "expected KEY-1234" message to the input for `aria-describedby`. */
const TICKET_ERROR_ID = "start-work-ticket-error";

/**
 * Start work on a ticket: assign it to yourself, and open the empty draft PR
 * that puts it in "My PRs" with a terminal button beside it.
 *
 * Markup and local form state only. The rules — what counts as a ticket id, what
 * the PR is called, when the ticket is someone else's — are in `lib/startWork.ts`
 * where they are tested; the request is in `useStartWork`.
 */
export default function StartWorkCard({
  repos,
  teamKey,
  onStarted,
}: {
  repos: RepoConfig[];
  /** The configured Linear team, so the example id is one the user would type. */
  teamKey: string;
  /** Refetch hook, so the new PR appears without waiting for the poll. */
  onStarted?: () => void;
}) {
  const [ticketId, setTicketId] = useState("");
  const [repo, setRepo] = useRememberedRepo(repos);
  const { pending, result, start, reset } = useStartWork(onStarted);

  // Validated as you type so the button can't post something the server will
  // only reject after a round trip. Empty is not "invalid" — it's just not ready.
  const parsed = parseTicketId(ticketId);
  const canSubmit = parsed !== null && repo !== "" && !pending;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    void start(parsed, repo);
  };

  const badTicket = ticketId !== "" && parsed === null;

  return (
    <div className="rounded-lg border border-line bg-bg-panel p-5">
      <div className="mb-5 flex items-baseline justify-between">
        <h2 className="text-base font-semibold">Start Work</h2>
        <span className="text-xs text-text-muted">
          assigns the ticket, opens a draft PR
        </span>
      </div>

      <form onSubmit={submit} className="flex flex-wrap items-center gap-2">
        <input
          value={ticketId}
          onChange={(e) => {
            setTicketId(e.target.value);
            if (result) reset();
          }}
          placeholder={`${teamKey}-1234`}
          aria-label="Linear ticket id"
          // Without these the button is simply disabled with no stated reason —
          // the explanation beside it is invisible to a screen reader.
          aria-invalid={badTicket}
          aria-describedby={badTicket ? TICKET_ERROR_ID : undefined}
          spellCheck={false}
          className="w-40 rounded-sm border border-line bg-bg-row px-2 py-1.5 text-sm text-text-primary placeholder:text-text-dim focus:border-accent-blue focus:outline-hidden"
        />
        <select
          value={repo}
          onChange={(e) => setRepo(e.target.value)}
          aria-label="Repository for the pull request"
          // The one control that grows, so the row reaches the card's edge
          // instead of trailing off two thirds across. It earns the slack: repo
          // names are the longest thing here and the only part that varies,
          // where a ticket id is always about eight characters. `min-w-0` because
          // a flex item won't shrink below its content otherwise, which would
          // push the button out of the card on a narrow window.
          className="pitwall-select min-w-0 flex-1 rounded-sm border border-line bg-bg-row px-2 py-1.5 text-sm text-text-primary focus:border-accent-blue focus:outline-hidden"
        >
          {repos.map((r) => {
            const slug = `${r.owner}/${r.name}`;
            return (
              <option key={slug} value={slug}>
                {r.name}
              </option>
            );
          })}
        </select>
        <button
          type="submit"
          disabled={!canSubmit}
          className="rounded-sm border border-accent-blue/40 bg-accent-blue/15 px-3 py-1.5 text-sm font-medium text-accent-blue transition-ui hover:bg-accent-blue/25 disabled:cursor-not-allowed disabled:border-line disabled:bg-bg-row disabled:text-text-dim"
        >
          {pending ? "Starting…" : "Start work"}
        </button>
        {/* Only once there is something to correct — an empty field isn't wrong. */}
        {badTicket && (
          <span id={TICKET_ERROR_ID} className="text-xs text-text-muted">
            Expected something like {teamKey}-1234.
          </span>
        )}
      </form>

      {/* The live region wraps the empty case too, so it is in the DOM before the
          result arrives — a region added at the same moment as its content is
          not reliably announced. */}
      <div aria-live="polite">{result && <Result result={result} />}</div>
    </div>
  );
}

function Result({ result }: { result: ReturnType<typeof useStartWork>["result"] }) {
  if (!result) return null;

  if (!result.started) {
    return (
      <p className="mt-4 rounded-sm border border-accent-red/30 bg-accent-red/10 p-3 text-sm text-accent-red">
        {result.error ?? "Nothing was started."}
      </p>
    );
  }

  return (
    <div className="mt-4 rounded-sm border border-accent-green/30 bg-accent-green/10 p-3 text-sm">
      <p className="text-accent-green">
        {startWorkSummary(result)}
        {result.pr && (
          <>
            {" — "}
            <a
              href={result.pr.url}
              target="_blank"
              rel="noreferrer"
              className="underline hover:text-text-primary"
            >
              open the PR
            </a>
          </>
        )}
        {result.ticket && (
          <>
            {" · "}
            <a
              href={result.ticket.url}
              target="_blank"
              rel="noreferrer"
              className="underline hover:text-text-primary"
            >
              {result.ticket.identifier}
            </a>
          </>
        )}
      </p>
      {/* Not failures: the PR already existed, the ticket was already yours.
          Shown because each is a thing the user asked for that didn't happen. */}
      {result.notes.length > 0 && (
        <ul className="mt-2 space-y-1 text-xs text-text-muted">
          {result.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
