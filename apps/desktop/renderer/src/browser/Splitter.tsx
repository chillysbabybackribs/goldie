import { useCallback, useEffect, useRef } from "react";

/**
 * A thin draggable divider. Reports the chat's new width fraction as the user
 * drags. While dragging we add a transparent full-window overlay so the cursor
 * stays consistent and pointer events don't get swallowed by the native
 * WebContentsView (which sits above the renderer and would otherwise eat them).
 */
export function Splitter({
  containerRef,
  onFraction,
  min = 0.25,
  max = 0.6,
}: {
  containerRef: React.RefObject<HTMLElement | null>;
  onFraction: (fraction: number) => void;
  min?: number;
  max?: number;
}) {
  const dragging = useRef(false);

  const onMove = useCallback(
    (e: PointerEvent) => {
      if (!dragging.current) return;
      const el = containerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const f = (e.clientX - rect.left) / rect.width;
      onFraction(Math.min(max, Math.max(min, f)));
    },
    [containerRef, onFraction, min, max],
  );

  const stop = useCallback(() => {
    dragging.current = false;
    document.body.style.cursor = "";
    document.getElementById("goldie-drag-shield")?.remove();
  }, []);

  useEffect(() => {
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", stop);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", stop);
    };
  }, [onMove, stop]);

  const start = () => {
    dragging.current = true;
    document.body.style.cursor = "col-resize";
    // Overlay shield so dragging over the native page still tracks.
    const shield = document.createElement("div");
    shield.id = "goldie-drag-shield";
    shield.style.cssText =
      "position:fixed;inset:0;z-index:9999;cursor:col-resize";
    document.body.appendChild(shield);
  };

  return (
    <div
      onPointerDown={start}
      className="group relative z-10 flex w-1.5 shrink-0 cursor-col-resize items-center justify-center"
      role="separator"
      aria-label="Resize browser panel"
    >
      <div className="h-10 w-[3px] rounded-full bg-line-strong transition-colors group-hover:bg-ink-faint" />
    </div>
  );
}
