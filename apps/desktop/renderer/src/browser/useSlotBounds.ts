import { useEffect, type RefObject } from "react";

/**
 * Keeps the native WebContentsView aligned with a DOM "slot" element.
 *
 * The view is composited OVER the renderer, not inside it, so we continuously
 * report the slot's on-screen rect to main, which positions the page to match.
 * getBoundingClientRect() is already in CSS-pixel/window-content space — the
 * same space main uses for setBounds — so the rect maps over directly.
 *
 * The tricky part is CSS transitions: when the panel changes mode the slot
 * animates its size/position over ~300ms. A single post-layout measurement
 * would capture a mid-animation frame and stick there. So we re-measure on:
 *   - element resize (ResizeObserver)
 *   - window resize
 *   - transitionend anywhere in the layout
 *   - every animation frame for a short window after `deps` change
 * The last one is what makes the page track the slot smoothly during a slide.
 */
export function useSlotBounds(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
  deps: unknown[] = [],
): void {
  useEffect(() => {
    const el = ref.current;
    if (!el || !active) return;

    const measure = () => {
      const r = el.getBoundingClientRect();
      void window.goldie.browser.setBounds({
        x: r.left,
        y: r.top,
        width: r.width,
        height: r.height,
      });
    };

    // Track continuously for ~400ms after a layout change so the native view
    // follows the slot through its CSS transition, then settle.
    let rafId = 0;
    const startTime = performance.now();
    const follow = (now: number) => {
      measure();
      if (now - startTime < 420) rafId = requestAnimationFrame(follow);
    };
    rafId = requestAnimationFrame(follow);

    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener("resize", measure);
    // transitionend bubbles, so listen on the document for any layout settle.
    document.addEventListener("transitionend", measure);

    return () => {
      cancelAnimationFrame(rafId);
      ro.disconnect();
      window.removeEventListener("resize", measure);
      document.removeEventListener("transitionend", measure);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref, active, ...deps]);
}
