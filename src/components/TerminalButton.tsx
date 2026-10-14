"use client";

import type { MyPR } from "@/types";

/**
 * Opens the PR's terminal.
 *
 * Rendered only for repos with a `localPath` in config.json — without a local
 * clone there is nowhere to put the worktree, so the alternative would be a
 * button whose only outcome is an error.
 */
export default function TerminalButton({
  pr,
  onOpen,
}: {
  pr: MyPR;
  onOpen: (pr: MyPR) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onOpen(pr)}
      aria-label={`Open terminal for ${pr.repo}#${pr.number}`}
      title={`Open a terminal on ${pr.headRefName}`}
      className="shrink-0 rounded-sm p-0.5 text-text-muted transition-ui hover:bg-bg-row hover:text-accent-green"
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 16 16"
        className="h-3.5 w-3.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5" />
        <path d="M4.5 6.5 6.5 8l-2 1.5M8.25 9.75h3.25" />
      </svg>
    </button>
  );
}
