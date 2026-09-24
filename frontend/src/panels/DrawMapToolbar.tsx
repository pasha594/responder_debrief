/**
 * Drawing tools on the map's top-right corner, shown while the Draw tab is
 * open (on phones, whatever height the sheet is at): stop drawing, flip the
 * last directional line, erase, undo / redo, clear. The Draw tab itself keeps
 * only the palette.
 */
import { useStore } from '../state/store';
import { drawLineById, isDirectionalLine } from '../map/layers/drawSymbols';
import { flipLatestLine } from '../map/layers/drawPlan';

export function DrawMapToolbar() {
  const open = useStore((s) => s.ui.sidebarTab === 'draw');
  const draw = useStore((s) => s.draw);
  const actions = useStore((s) => s.actions);
  if (!open) return null;

  const { tool } = draw;
  const lineStyle = tool.startsWith('line:') ? drawLineById(tool.slice('line:'.length)) : undefined;
  const directional = !!lineStyle && isDirectionalLine(lineStyle);
  const flipped = directional ? flipLatestLine(draw.features, lineStyle.id) : null;

  return (
    <div className="rd-draw-mapbar" role="toolbar" aria-label="Drawing tools">
      {tool !== 'none' && (
        <button
          type="button"
          className="rd-draw-mapbtn rd-draw-mapbtn--stop"
          onClick={() => actions.setDrawTool('none')}
        >
          ✕ Stop drawing
        </button>
      )}
      {directional && (
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
          ↩ Undo
        </button>
        <button
          type="button"
          className="rd-draw-mapbtn"
          onClick={actions.drawRedo}
          disabled={!draw.future.length}
          title="Redo"
        >
          ↪ Redo
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
    </div>
  );
}
