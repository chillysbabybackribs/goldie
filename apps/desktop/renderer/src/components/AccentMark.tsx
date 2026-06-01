/**
 * The gradient "arc" mark — the single saturated element in the UI.
 * A soft, rounded peak (the Antigravity-style ∧) filled with the accent
 * gradient. Used large in the empty state and small in the titlebar.
 */
export function AccentMark({ size = 28 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      fill="none"
      aria-hidden
    >
      <defs>
        {/* Sweep the gradient horizontally across the full width of the arc
            so the blue→violet→rose→amber spectrum reads end to end, like the
            reference mark, rather than collapsing into a single hue. */}
        <linearGradient id="goldie-accent" x1="18" y1="0" x2="82" y2="0">
          <stop offset="0%" stopColor="#5ad1ff" />
          <stop offset="38%" stopColor="#a78bfa" />
          <stop offset="70%" stopColor="#fca5a5" />
          <stop offset="100%" stopColor="#fcd34d" />
        </linearGradient>
      </defs>
      {/* A wide, soft rounded peak: rise to an apex and back down, stroked
          thick with round caps so it reads as a gentle arch, not a sharp ∧. */}
      <path
        d="M18 72 C 33 72, 41 34, 50 34 C 59 34, 67 72, 82 72"
        stroke="url(#goldie-accent)"
        strokeWidth="12"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
