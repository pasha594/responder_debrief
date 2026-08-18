/**
 * Draw tab: annotate the map for a briefing. Pick a symbol and tap the map
 * to place it; freehand to sketch line work; erase taps features away.
 * Undo/redo/clear cover the session; annotations persist per fire on this
 * device (localStorage) — nothing is uploaded.
 */
import { useStore, type DrawTool } from '../../state/store';
import { DRAW_LINES, DRAW_SYMBOLS } from '../../map/layers/drawSymbols';

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
            const shapeCls =
              sym.shape === 'none' ? 'rd-draw-shape--bare' : `rd-draw-shape--${sym.shape}`;
            return (
              <button
                key={sym.id}
                type="button"
                className={`rd-draw-sym${draw.tool === tool ? ' rd-draw-sym--active' : ''}`}
                onClick={() => toggle(tool)}
                aria-pressed={draw.tool === tool}
                title={sym.label}
              >
                <span
                  className={`rd-draw-sym-disc ${shapeCls}`}
                  style={
                    sym.shape === 'none'
                      ? { color: sym.color }
                      : { background: sym.color, color: '#151015' }
                  }
                >
                  <span className="rd-draw-sym-glyph">{sym.glyph}</span>
                </span>
                <span className="rd-draw-sym-name">{sym.label}</span>
              </button>
            );
          })}
        </div>
      </section>

      <section className="rd-section">
        <h3 className="rd-section-title">
          Lines
          <span className="rd-title-meta">pick one, then drag on the map</span>
        </h3>
        <div className="rd-draw-lines">
          {DRAW_LINES.map((ls) => {
            const tool: DrawTool = ls.id === 'sketch' ? 'freehand' : `line:${ls.id}`;
            return (
              <button
                key={ls.id}
                type="button"
                className={`rd-draw-line-btn${draw.tool === tool ? ' rd-draw-line-btn--active' : ''}`}
                onClick={() => toggle(tool)}
                aria-pressed={draw.tool === tool}
              >
                <span className="rd-draw-line-sample">
                  {ls.letter ? (
                    <span className="rd-draw-line-letters" style={{ color: ls.color }}>
                      {ls.letter}
                      <span className="rd-draw-line-rule" style={{ background: ls.color }} />
                      {ls.letter}
                    </span>
                  ) : (
                    <span
                      className="rd-draw-line-rule"
                      style={{
                        background:
                          ls.dash === 'solid'
                            ? ls.color
                            : ls.dash === 'hatch'
                              ? `repeating-linear-gradient(70deg, ${ls.color} 0 1.5px, transparent 1.5px 5px), repeating-linear-gradient(-70deg, ${ls.color} 0 1.5px, transparent 1.5px 5px)`
                              : `repeating-linear-gradient(90deg, ${ls.color} 0 ${
                                  ls.dash === 'dots' ? '3px' : '7px'
                                }, transparent ${ls.dash === 'dots' ? '3px' : '7px'} ${
                                  ls.dash === 'dots' ? '8px' : '12px'
                                })`,
                        height: ls.dash === 'hatch' ? 9 : (ls.width ?? 3) - 0.5,
                      }}
                    />
                  )}
                </span>
                <span className="rd-draw-sym-name">{ls.label}</span>
              </button>
            );
          })}
        </div>
      </section>

      <section className="rd-section">
        <h3 className="rd-section-title">Tools</h3>
        <div className="rd-draw-tools">
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

      <div className="rd-field-note">
        Annotations stay on this device, saved per fire. {draw.features.length} mark
        {draw.features.length === 1 ? '' : 's'} on the map.
      </div>
    </div>
  );
}
