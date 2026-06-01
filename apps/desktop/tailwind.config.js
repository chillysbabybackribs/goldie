/** @type {import('tailwindcss').Config} */
export default {
  content: ["./renderer/index.html", "./renderer/src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // The Antigravity surface stack — deep charcoal, not pure black.
        // Each step is a barely-perceptible lift so depth reads through
        // value, never through hard borders.
        canvas: "#16181b", // window background, behind the card
        card: "#1c1f23", // the floating card surface
        raised: "#22262b", // composer / inputs / hover wells
        overlay: "#2a2f35", // menus, popovers
        // Text is white at descending opacities — hierarchy without color.
        ink: {
          DEFAULT: "rgba(255,255,255,0.92)", // primary
          muted: "rgba(255,255,255,0.50)", // secondary
          faint: "rgba(255,255,255,0.30)", // tertiary / placeholder
          ghost: "rgba(255,255,255,0.14)", // disabled / hairline icons
        },
        // Hairline borders — the "barely there" 1px edges.
        line: {
          DEFAULT: "rgba(255,255,255,0.06)",
          strong: "rgba(255,255,255,0.10)",
        },
      },
      borderRadius: {
        card: "20px", // the big floating-card corner
        panel: "16px",
        well: "12px", // composer / pills
      },
      boxShadow: {
        // A soft lift that makes the card feel like it hovers over the canvas.
        card: "0 24px 60px -20px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.05)",
        well: "inset 0 0 0 1px rgba(255,255,255,0.06)",
      },
      fontFamily: {
        sans: [
          "Inter",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "system-ui",
          "sans-serif",
        ],
      },
      backgroundImage: {
        // The single saturated accent in the whole UI — the gradient mark.
        "accent-mark":
          "linear-gradient(115deg, #5ad1ff 0%, #a78bfa 45%, #fca5a5 75%, #fcd34d 100%)",
      },
      transitionTimingFunction: {
        // Calm, slightly-overshooting ease for panel + composer motion.
        soft: "cubic-bezier(0.22, 1, 0.36, 1)",
      },
    },
  },
  plugins: [],
};
