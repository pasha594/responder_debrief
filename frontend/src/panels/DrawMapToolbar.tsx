/**
 * Drawing tools, shown while the Draw tab is open (on phones, whatever height
 * the sheet is at): stop drawing, flip the last directional line, erase,
 * undo / redo, clear. The Draw tab itself keeps only the palette. On desktop
 * they sit in the map's top-right corner; on phones and touch tablets they
 * ride under the search bar, folded behind one "Drawing Tools" button (lit while a tool is armed)
 * that opens the list — a tap elsewhere folds it again. App mounts one of each
 * placement; each renders only in its own layout.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../state/store';
import { drawLineById, isDirectionalLine } from '../map/layers/drawSymbols';
import { flipLatestLine } from '../map/layers/drawPlan';
import { useCompactControls } from '../utils/useMediaQuery';
import { useDismiss } from '../utils/useDismiss';

/** Hooked arrow for Undo; Redo gets its mirror image. Stroked like the locate icon. */
function UndoRedoIcon({ redo = false }: { redo?: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="15"
      height="15"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={redo ? { transform: 'scaleX(-1)' } : undefined}
    >
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h10.5a5 5 0 0 1 0 10H11" />
    </svg>
  );
}

export function DrawMapToolbar({ placement }: { placement: 'corner' | 'stack' }) {
  const tabOpen = useStore((s) => s.ui.sidebarTab === 'draw');
  const draw = useStore((s) => s.draw);
  const actions = useStore((s) => s.actions);
  const fullControls = !useCompactControls();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  const here = (placement === 'corner') === fullControls;
  useDismiss(ref, open && tabOpen && here && !fullControls, close);
  // leaving the Draw tab folds the menu, so it doesn't reopen stale
  useEffect(() => {
    if (!tabOpen) setOpen(false);
  }, [tabOpen]);
  if (!tabOpen || !here) return null;

  const { tool } = draw;
  const lineStyle = tool.startsWith('line:') ? drawLineById(tool.slice('line:'.length)) : undefined;
  const directional = !!lineStyle && isDirectionalLine(lineStyle);
  const flipped = directional ? flipLatestLine(draw.features, lineStyle.id) : null;
  const showTools = fullControls || open;

  return (
    <div
      className={`rd-draw-mapbar rd-draw-mapbar--${placement}`}
      role="toolbar"
      aria-label="Drawing tools"
      ref={ref}
    >
      {!fullControls && (
        <button
          type="button"
          className={`rd-draw-mapbtn rd-draw-mapbtn--toggle${tool !== 'none' ? ' rd-draw-mapbtn--armed' : ''}`}
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          title={tool !== 'none' ? 'Drawing — tap for tools' : undefined}
        >
          ✎ Drawing Tools {open ? '▴' : '▾'}
        </button>
      )}
      {showTools && tool !== 'none' && (
        <button
          type="button"
          className="rd-draw-mapbtn rd-draw-mapbtn--stop"
          onClick={() => actions.setDrawTool('none')}
        >
          ✕ Stop drawing
        </button>
      )}
      {showTools && directional && (
        <button
          type="button"
          className="rd-draw-mapbtn"
          onClick={() => flipped && actions.drawCommit(flipped)}
          disabled={!flipped}
          title={
            flipped
              ? `Reverse the last ${lineStyle.label} line so its marks sit on the other side`
              : `Draw a ${lineStyle.label} line first`
          }
        >
          ⇄ Flip line direction
        </button>
      )}
      {showTools && (
        <>
          <button
            type="button"
            className="rd-draw-mapbtn"
            onClick={() => actions.setDrawTool(tool === 'erase' ? 'none' : 'erase')}
            aria-pressed={tool === 'erase'}
            title="Tap a mark to remove it"
          >
            ⌫ Erase
          </button>
          <div className="rd-draw-mapbar-pair">
            <button
              type="button"
              className="rd-draw-mapbtn"
              onClick={actions.drawUndo}
              disabled={!draw.past.length}
              title="Undo"
            >
              <UndoRedoIcon /> Undo
            </button>
            <button
              type="button"
              className="rd-draw-mapbtn"
              onClick={actions.drawRedo}
              disabled={!draw.future.length}
              title="Redo"
            >
              <UndoRedoIcon redo /> Redo
            </button>
          </div>
          <button
            type="button"
            className="rd-draw-mapbtn"
            onClick={actions.drawClear}
            disabled={!draw.features.length}
            title="Remove every annotation"
          >
            Clear all
          </button>
        </>
      )}
    </div>
  );
}
