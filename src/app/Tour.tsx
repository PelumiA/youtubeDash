import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Navigate } from "./App";
import { TOUR, cardPosition, type Rect } from "./tourSteps";
import { Button } from "./ui";

const PAD = 6;

/** Step-by-step walkthrough: switches pages and outlines the control each step talks about. */
export default function Tour({ onNavigate, onClose }: { onNavigate: Navigate; onClose: () => void }) {
  const [i, setI] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const card = useRef<HTMLDivElement>(null);
  const step = TOUR[i];
  const last = i === TOUR.length - 1;

  useEffect(() => {
    if (step.route) onNavigate(step.route);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [i]);

  // Measure the target (after the page switch renders) and follow window resizes.
  useLayoutEffect(() => {
    const measure = () => {
      const el = step.target ? document.querySelector(`[data-tour="${step.target}"]`) : null;
      const r = el?.getBoundingClientRect();
      const next = r && r.width ? { x: r.x - PAD, y: r.y - PAD, w: r.width + 2 * PAD, h: r.height + 2 * PAD } : null;
      setRect(next);
      const c = card.current?.getBoundingClientRect();
      setPos(cardPosition(next, { w: c?.width ?? 360, h: c?.height ?? 220 }, { w: window.innerWidth, h: window.innerHeight }));
    };
    measure();
    const t = setTimeout(measure, 120);
    window.addEventListener("resize", measure);
    return () => {
      clearTimeout(t);
      window.removeEventListener("resize", measure);
    };
  }, [i, step.target]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight" || e.key === "Enter") last ? onClose() : setI((n) => n + 1);
      else if (e.key === "ArrowLeft") setI((n) => Math.max(0, n - 1));
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [last, onClose]);

  return (
    <div className="fixed inset-0 z-[60]" role="dialog" aria-modal="true" aria-label="Tour">
      {rect ? (
        // A huge shadow around the outline dims everything except the highlighted control.
        <div
          className="pointer-events-none absolute rounded-lg ring-2 ring-accent transition-all duration-200"
          style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h, boxShadow: "0 0 0 9999px rgba(0,0,0,0.55)" }}
        />
      ) : (
        <div className="absolute inset-0 bg-black/55" />
      )}
      <div
        ref={card}
        className="absolute w-[360px] max-w-[calc(100vw-24px)] rounded-lg border border-line bg-panel shadow-xl transition-all duration-200"
        style={{ left: pos.x, top: pos.y }}
      >
        <div className="px-4 pt-3">
          <div className="text-[11px] text-muted">Step {i + 1} of {TOUR.length}</div>
          <h2 className="mt-0.5 font-semibold">{step.title}</h2>
        </div>
        <div className="space-y-2 px-4 py-2 text-sm leading-relaxed">
          {step.body.map((p) => <p key={p}>{p}</p>)}
        </div>
        <div className="flex items-center justify-between gap-2 border-t border-line px-4 py-2.5">
          <Button variant="ghost" className="!px-2 text-xs" onClick={onClose}>{last ? "Close" : "Skip tour"}</Button>
          <span className="flex gap-2">
            {i > 0 && <Button onClick={() => setI(i - 1)}>Back</Button>}
            <Button variant="primary" onClick={() => (last ? onClose() : setI(i + 1))} autoFocus>{last ? "Done" : "Next"}</Button>
          </span>
        </div>
      </div>
    </div>
  );
}
