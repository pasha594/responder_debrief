/** Bottom sheet (mobile <768px): snap points peek / half / full, drag handle. */
import { useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { useStore, type AppState } from '../state/store';

type Snap = AppState['ui']['sheetSnap'];

const SNAP_CLASS: Record<Snap, string> = {
  peek: 'rd-sheet--peek',
  half: 'rd-sheet--half',
  full: 'rd-sheet--full',
};

function timelineHeightPx(): number {
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue('--timeline-h')
    .trim();
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : 64;
}

/** Snap heights in px for the current viewport. */
function snapHeights(): Record<Snap, number> {
  const avail = window.innerHeight - timelineHeightPx();
  return { peek: 96, half: avail * 0.45, full: avail * 0.9 };
}

export function MobileSheet({ children }: { children: ReactNode }) {
  const snap = useStore((s) => s.ui.sheetSnap);
  const setSheetSnap = useStore((s) => s.actions.setSheetSnap);
  const sheetRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ startY: number; startH: number } | null>(null);
  const [dragH, setDragH] = useState<number | null>(null);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (!sheetRef.current) return;
    // The whole tray header drags, not just the grabber tip — but content
    // below it (tabs, checkboxes, sliders) must keep normal touch behavior.
    const target = e.target as HTMLElement;
    if (!target.closest('.rd-sheet-handle, .rd-fp-header')) return;
    drag.current = { startY: e.clientY, startH: sheetRef.current.offsetHeight };
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // a pointer that already ended (fast tap) can't be captured — the
      // drag simply won't track, which is fine
    }
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const heights = snapHeights();
    const h = drag.current.startH + (drag.current.startY - e.clientY);
    setDragH(Math.min(Math.max(h, 56), heights.full));
  };

  const onPointerUp = () => {
    if (!drag.current) return;
    const h = dragH ?? drag.current.startH;
    drag.current = null;
    setDragH(null);
    const heights = snapHeights();
    let best: Snap = 'peek';
    let bestDist = Infinity;
    for (const s of ['peek', 'half', 'full'] as Snap[]) {
      const d = Math.abs(heights[s] - h);
      if (d < bestDist) {
        best = s;
        bestDist = d;
      }
    }
    setSheetSnap(best);
  };

  return (
    <div
      ref={sheetRef}
      className={`rd-sheet ${SNAP_CLASS[snap]}${dragH != null ? ' rd-sheet--dragging' : ''}`}
      style={dragH != null ? { height: `${dragH}px` } : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <div
        className="rd-sheet-handle"
        role="slider"
        aria-label="Resize panel"
        aria-valuenow={snap === 'peek' ? 0 : snap === 'half' ? 50 : 100}
      >
        <span className="rd-sheet-handle-bar" aria-hidden="true" />
      </div>
      <div className="rd-sheet-content">{children}</div>
    </div>
  );
}
