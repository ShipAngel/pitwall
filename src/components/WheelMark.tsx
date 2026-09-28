/**
 * The tyre beside the wordmark — a soft-compound sidewall, as F1 marks its
 * tyres.
 *
 * Drawn rather than imported: an inline SVG costs no request, scales without a
 * second asset, and takes its tread colour from the surrounding text, so it
 * can't drift from the theme the way a committed PNG would.
 *
 * Two shapes only, deliberately. A tyre seen side-on is concentric circles, and
 * at the 24px the header gives it detail is the first thing to go: a treaded
 * version read as a cog, and an earlier realistic steering wheel came out
 * looking like a mushroom. What survives at this size is the silhouette and the
 * colour, so those are all this leans on — the red is what says "tyre" here, not
 * the geometry.
 *
 * `aria-hidden` because the word "Pitwall" is right beside it: announcing both
 * would just make a screen reader say the name twice.
 */
export default function WheelMark({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
      focusable="false"
      className={`shrink-0 ${className}`}
    >
      {/* Sidewall. currentColor so the caller sets it and the theme stays the
          single source of that red. */}
      <circle cx="16" cy="16" r="12.5" stroke="currentColor" strokeWidth="5" />
      {/* Rim, in the primary text colour so it reads as a different material to
          the rubber around it. */}
      <circle cx="16" cy="16" r="5" stroke="#e6e9ee" strokeWidth="2.5" />
    </svg>
  );
}
