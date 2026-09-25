/**
 * Drawing tools, shown while the Draw tab is open (on phones, whatever height
 * the sheet is at): stop drawing, flip the last directional line, erase,
 * undo / redo, clear. The Draw tab itself keeps only the palette. On desktop
 * they sit in the map's top-right corner; on phones, touch tablets and narrow
 * windows they ride under the search bar, folded behind one "Drawing Tools"
 * button (lit while a tool is armed) that opens the list — a tap elsewhere
 * folds it again. App mounts one of each placement; each renders only in its
 * own layout.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../state/store';
import { drawLineById, isDirectionalLine } from '../map/layers/drawSymbols';
import { flipLatestLine } from '../map/layers/drawPlan';
import { useCompactControls } from '../utils/useMediaQuery';
import { useDismiss } from '../utils/useDismiss';

/** The buttons' icons: 24-unit line drawings, stroked like the locate icon. */
const TOOL_ICONS = {
  pencil: 'M16.5 4.5l3 3-11 11-4 1 1-4zM14 7l3 3',
  stop: 'M6 6l12 12M18 6 6 18',
  flip: 'M4 8h15M15 4l4 4-4 4M20 16H5M9 12l-4 4 4 4',
  erase: 'M9 5h11a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H9l-6-7zM12 9l6 6M18 9l-6 6',
  undo: 'M9 14 4 9l5-5M4 9h10.5a5 5 0 0 1 0 10H11',
  redo: 'M15 14l5-5-5-5M20 9H9.5a5 5 0 0 0 0 10H13',
};

function ToolIcon({ name }: { name: keyof typeof TOOL_ICONS }) {
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
    >
      <path d={TOOL_ICONS[name]} />
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
          <ToolIcon name="pencil" /> Drawing Tools {open ? '▴' : '▾'}
        </button>
      )}
      {showTools && tool !== 'none' && (
        <button
          type="button"
          className="rd-draw-mapbtn rd-draw-mapbtn--stop"
          onClick={() => actions.setDrawTool('none')}
        >
          <ToolIcon name="stop" /> Stop drawing
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
          <ToolIcon name="flip" /> Flip line direction
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
            <ToolIcon name="erase" /> Erase
          </button>
          <div className="rd-draw-mapbar-pair">
            <button
              type="button"
              className="rd-draw-mapbtn"
              onClick={actions.drawUndo}
              disabled={!draw.past.length}
              title="Undo"
            >
              <ToolIcon name="undo" /> Undo
            </button>
            <button
              type="button"
              className="rd-draw-mapbtn"
              onClick={actions.drawRedo}
              disabled={!draw.future.length}
              title="Redo"
            >
              <ToolIcon name="redo" /> Redo
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
