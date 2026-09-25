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

/** Vertical travel before a press on the header counts as a drag, not a click. */
const DRAG_SLOP_PX = 6;

interface SheetDrag {
  pointerId: number;
  startY: number;
  startH: number;
  /** Height the sheet was last dragged to; snapped on release. */
  h: number;
  dragging: boolean;
}

export function MobileSheet({ children }: { children: ReactNode }) {
  const snap = useStore((s) => s.ui.sheetSnap);
  const setSheetSnap = useStore((s) => s.actions.setSheetSnap);
  const sheetRef = useRef<HTMLDivElement>(null);
  const drag = useRef<SheetDrag | null>(null);
  const [dragH, setDragH] = useState<number | null>(null);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (!sheetRef.current || e.button !== 0 || drag.current) return;
    // The whole tray header drags, not just the grabber tip — but content
    // below it (tabs, checkboxes, sliders) must keep normal touch behavior.
    const target = e.target as HTMLElement;
    if (!target.closest('.rd-sheet-handle, .rd-fp-header')) return;
    const startH = sheetRef.current.offsetHeight;
    drag.current = { pointerId: e.pointerId, startY: e.clientY, startH, h: startH, dragging: false };
    // Capture on the pressed element, not the sheet: a press that never
    // passes the slop must still click the tab under it. Moves still bubble
    // up to the sheet if a fast flick leaves it before the drag starts.
    try {
      target.setPointerCapture(e.pointerId);
    } catch {
      // a pointer that already ended (fast tap) can't be captured — the
      // drag simply won't track, which is fine
    }
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    if (!d.dragging) {
      if (Math.abs(d.startY - e.clientY) < DRAG_SLOP_PX) return;
      d.dragging = true;
      // Past the slop it's a drag: move capture to the sheet so the release
      // (and its click) lands there and never switches tabs.
      try {
        sheetRef.current?.setPointerCapture(e.pointerId);
      } catch {
        // pointer already gone; the release below still snaps
      }
    }
    const heights = snapHeights();
    d.h = Math.min(Math.max(d.startH + (d.startY - e.clientY), 56), heights.full);
    setDragH(d.h);
  };

  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    drag.current = null;
    if (!d.dragging) return;
    setDragH(null);
    const heights = snapHeights();
    let best: Snap = 'peek';
    let bestDist = Infinity;
    for (const s of ['peek', 'half', 'full'] as Snap[]) {
      const dist = Math.abs(heights[s] - d.h);
      if (dist < bestDist) {
        best = s;
        bestDist = dist;
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
