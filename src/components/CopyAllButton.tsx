"use client";

import { useCopyToClipboard } from "@/hooks/useCopyToClipboard";
import { copyAllLabels, prListForClipboard } from "@/lib/view";

/**
 * Copies every PR link in a panel, for pasting into a standup or a thread.
 *
 * Text rather than the row icon: this acts on the whole panel, and an icon
 * identical to the per-row ones would read as copying whichever row it sat
 * nearest. It renders nothing at all for an empty list — a button that would
 * put an empty string on the clipboard is worse than no button.
 */
export default function CopyAllButton({ prs }: { prs: readonly { url: string }[] }) {
  const { copied, copy } = useCopyToClipboard();
  if (prs.length === 0) return null;

  const { label, aria } = copyAllLabels(prs.length, copied);
  return (
    <button
      type="button"
      onClick={() => void copy(prListForClipboard(prs))}
      aria-label={aria}
      title={aria}
      className={`shrink-0 rounded border px-2 py-0.5 text-xs transition ${
        copied
          ? "border-accent-green/40 bg-accent-green/10 text-accent-green"
          : "border-line bg-bg-row text-text-muted hover:border-accent-blue/40 hover:text-text-primary"
      }`}
    >
      {label}
    </button>
  );
}
