"use client";

import { useCopyToClipboard } from "@/hooks/useCopyToClipboard";
import { copyButtonLabels } from "@/lib/view";

/**
 * Copies a URL to the clipboard, with a brief tick as confirmation.
 *
 * The timer, its cleanup and the silent-failure rule live in
 * `useCopyToClipboard`, shared with the panel-level copy button.
 */
export default function CopyButton({
  url,
  label,
}: {
  url: string;
  label: string;
}) {
  const { copied, copy } = useCopyToClipboard();

  // aria-label rather than a visible label: the icon sits in a dense row, and the
  // URL it copies is already named by the link beside it.
  const { aria, title } = copyButtonLabels(url, label, copied);

  return (
    <button
      type="button"
      onClick={() => void copy(url)}
      aria-label={aria}
      title={title}
      className="shrink-0 rounded-sm p-0.5 text-text-muted transition hover:bg-bg-row hover:text-text-primary"
    >
      {copied ? (
        <svg
          aria-hidden="true"
          viewBox="0 0 16 16"
          className="h-3.5 w-3.5 text-accent-green"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M13 4.5 6 11.5 3 8.5" />
        </svg>
      ) : (
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
          <rect x="5.75" y="5.75" width="7.5" height="7.5" rx="1.5" />
          <path d="M10.25 3.75v-.5a1.5 1.5 0 0 0-1.5-1.5h-5.5a1.5 1.5 0 0 0-1.5 1.5v5.5a1.5 1.5 0 0 0 1.5 1.5h.5" />
        </svg>
      )}
    </button>
  );
}
