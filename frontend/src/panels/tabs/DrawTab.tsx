/**
 * Draw tab: annotate the map for a briefing. Pick a symbol and tap the map
 * to place it; freehand to sketch line work; erase taps features away.
 * Undo/redo/clear cover the session; annotations persist per fire on this
 * device (localStorage) — nothing is uploaded.
 */
import { useStore, type DrawTool } from '../../state/store';
import { DRAW_SYMBOLS } from '../../map/layers/drawSymbols';

function ToolButton({
  active,
  onClick,
  children,
  title,
  disabled,
}: {
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
  title?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={`rd-draw-tool${active ? ' rd-draw-tool--active' : ''}`}
      onClick={onClick}
      title={title}
      disabled={disabled}
      aria-pressed={active}
    >
      {children}
    </button>
  );
}

export function DrawTab() {
  const draw = useStore((s) => s.draw);
  const terrain3d = useStore((s) => s.ui.terrain3d);
  const actions = useStore((s) => s.actions);

  const toggle = (tool: DrawTool) =>
    actions.setDrawTool(draw.tool === tool ? 'none' : tool);

  return (
    <div className="rd-tab-body">
      <section className="rd-section">
        <h3 className="rd-section-title">
          Symbols
          <span className="rd-title-meta">pick one, then tap the map</span>
        </h3>
        <div className="rd-draw-palette">
          {DRAW_SYMBOLS.map((sym) => {
            const tool: DrawTool = `marker:${sym.id}`;
            return (
              <button
                key={sym.id}
                type="button"
                className={`rd-draw-sym${draw.tool === tool ? ' rd-draw-sym--active' : ''}`}
                onClick={() => toggle(tool)}
                aria-pressed={draw.tool === tool}
              >
                <span className="rd-draw-sym-disc" style={{ borderColor: sym.color, color: sym.color }}>
                  {sym.glyph}
                </span>
                <span className="rd-draw-sym-name">{sym.label}</span>
              </button>
            );
          })}
        </div>
      </section>

      <section className="rd-section">
        <h3 className="rd-section-title">Tools</h3>
        <div className="rd-draw-tools">
          <ToolButton
            active={draw.tool === 'freehand'}
            onClick={() => toggle('freehand')}
            title="Drag on the map to sketch a line"
          >
            ✏️ Freehand
          </ToolButton>
          <ToolButton
            active={draw.tool === 'erase'}
            onClick={() => toggle('erase')}
            title="Tap a mark to remove it"
          >
            ⌫ Erase
          </ToolButton>
        </div>
        <div className="rd-draw-tools">
          <ToolButton onClick={actions.drawUndo} disabled={!draw.past.length} title="Undo">
            ↩ Undo
          </ToolButton>
          <ToolButton onClick={actions.drawRedo} disabled={!draw.future.length} title="Redo">
            ↪ Redo
          </ToolButton>
          <ToolButton
            onClick={actions.drawClear}
            disabled={!draw.features.length}
            title="Remove every annotation"
          >
            Clear all
          </ToolButton>
        </div>
      </section>

      <section className="rd-section">
        <h3 className="rd-section-title">View</h3>
        <label className="rd-field--row">
          <input
            type="checkbox"
            checked={terrain3d}
            onChange={(e) => actions.setTerrain3d(e.target.checked)}
          />
          <span>3D terrain</span>
        </label>
        <div className="rd-field-note">
          Annotations stay on this device, saved per fire. {draw.features.length} mark
          {draw.features.length === 1 ? '' : 's'} on the map.
        </div>
      </section>
    </div>
  );
}
