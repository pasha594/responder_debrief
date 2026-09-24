/**
 * Draw tab: annotate the map for a briefing with the official NWCG PMS 936
 * symbology. Pick a symbol and tap the map to place it; pick a line style and
 * drag to draw it; erase taps features away. Undo/redo/clear cover the
 * session; annotations persist per fire on this device (localStorage) —
 * nothing is uploaded.
 */
import { useStore, type DrawTool } from '../../state/store';
import {
  DRAW_LINE_EXTRAS,
  DRAW_LINE_GROUPS,
  DRAW_SYMBOL_GROUPS,
  type DrawLineStyle,
} from '../../map/layers/drawSymbols';
import { linePreviewUrl } from '../../map/layers/drawImages';

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

function LineButton({
  style,
  tool,
  current,
  onToggle,
  title,
}: {
  style: DrawLineStyle;
  tool: DrawTool;
  current: DrawTool;
  onToggle: (tool: DrawTool) => void;
  title?: string;
}) {
  const active = current === tool;
  return (
    <button
      type="button"
      className={`rd-draw-line-btn${active ? ' rd-draw-line-btn--active' : ''}`}
      onClick={() => onToggle(tool)}
      aria-pressed={active}
      title={title}
    >
      <img className="rd-draw-line-sample" src={linePreviewUrl(style)} alt="" />
      <span className="rd-draw-sym-name">{style.label}</span>
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
        {DRAW_SYMBOL_GROUPS.map(({ category, items }) => (
          <div key={category} className="rd-draw-group">
            <h4 className="rd-draw-group-title">{category}</h4>
            <div className="rd-draw-palette">
              {items.map((sym) => {
                const tool: DrawTool = `marker:${sym.id}`;
                return (
                  <button
                    key={sym.id}
                    type="button"
                    className={`rd-draw-sym${draw.tool === tool ? ' rd-draw-sym--active' : ''}`}
                    onClick={() => toggle(tool)}
                    aria-pressed={draw.tool === tool}
                    title={sym.label}
                  >
                    <img
                      className={`rd-draw-sym-icon${sym.halo ? ' rd-draw-sym-icon--halo' : ''}`}
                      src={sym.url}
                      alt=""
                    />
                    <span className="rd-draw-sym-name">{sym.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </section>

      <section className="rd-section">
        <h3 className="rd-section-title">
          Lines
          <span className="rd-title-meta">pick one, then drag on the map</span>
        </h3>
        <div className="rd-draw-lines">
          {DRAW_LINE_EXTRAS.map((ls) => (
            <LineButton
              key={ls.id}
              style={ls}
              tool={ls.id === 'sketch' ? 'freehand' : `line:${ls.id}`}
              current={draw.tool}
              onToggle={toggle}
              title="Not an NWCG PMS 936 symbol"
            />
          ))}
        </div>
        {DRAW_LINE_GROUPS.map(({ category, items }) => (
          <div key={category} className="rd-draw-group">
            <h4 className="rd-draw-group-title">{category}</h4>
            <div className="rd-draw-lines">
              {items.map((ls) => (
                <LineButton
                  key={ls.id}
                  style={ls}
                  tool={`line:${ls.id}`}
                  current={draw.tool}
                  onToggle={toggle}
                />
              ))}
            </div>
          </div>
        ))}
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
        Symbols follow NWCG PMS 936. Annotations stay on this device, saved per fire.{' '}
        {draw.features.length} mark{draw.features.length === 1 ? '' : 's'} on the map.
      </div>
    </div>
  );
}
