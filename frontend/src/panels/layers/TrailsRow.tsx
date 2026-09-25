/**
 * Layers-tab rows for the trails overlay and the vegetation layer (the
 * Walk router's terrain model). Trails default to 'auto' — shown only on
 * the offline ground, where no basemap exists; the checkbox shows the
 * effective state and a click makes the choice explicit.
 */
import { useStore } from '../../state/store';
import { useFireBundle } from '../../routing/hooks';
import { VEG_CLASSES, STREAM_COLOR, STREAM_LABEL } from '../../routing/vegClasses';

export function TrailsRow() {
  const mode = useStore((s) => s.layers.trails.mode);
  const online = useStore((s) => s.offline.online);
  const setMode = useStore((s) => s.actions.setTrailsMode);
  const on = mode === 'on' || (mode === 'auto' && !online);
  return (
    <>
      <label className="rd-field--row" title="Forest Service, BLM and Park Service trails">
        <input type="checkbox" checked={on} onChange={() => setMode(on ? 'off' : 'on')} />
        <span>Trails</span>
        <span className="rd-title-meta">USFS · BLM · NPS{!online ? ' · offline copy' : ''}</span>
      </label>
      {on && (
        <div className="rd-hist-legend" aria-hidden="true">
          <span className="rd-hist-chip" style={{ background: '#0e8f8a' }} /> trail
          <span className="rd-hist-chip" style={{ background: '#0e8f8a', opacity: 0.55 }} /> not
          assessed (BLM)
        </div>
      )}
    </>
  );
}

export function VegetationRow({ corneaId }: { corneaId: string }) {
  const veg = useStore((s) => s.layers.vegetation);
  const setVeg = useStore((s) => s.actions.setVegetation);
  const bundle = useFireBundle(corneaId);
  const available = !!bundle.data;
  return (
    <>
      <label
        className="rd-field--row"
        title={available ? 'LANDFIRE vegetation used by offline Walk routing'
          : "Vegetation needs this fire's terrain model (not built yet)"}
      >
        <input
          type="checkbox"
          checked={veg.visible && available}
          disabled={!available}
          onChange={(e) => setVeg({ visible: e.target.checked })}
        />
        <span>Vegetation</span>
        <span className="rd-title-meta">
          {available ? `LANDFIRE ${bundle.data?.sources?.landfire?.veg ?? ''}`.trim() : 'not built yet'}
        </span>
      </label>
      {veg.visible && available && (
        <>
          <input
            type="range"
            className="rd-slider"
            min={0.1}
            max={1}
            step={0.05}
            value={veg.opacity}
            onChange={(e) => setVeg({ opacity: Number(e.target.value) })}
            aria-label="Vegetation opacity"
          />
          <div className="rd-hist-legend rd-veg-legend" aria-hidden="true">
            {VEG_CLASSES.filter((c) => c.id > 0).map((c) => (
              <span key={c.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <span className="rd-hist-chip" style={{ background: c.color }} />
                {c.label}
              </span>
            ))}
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <span className="rd-hist-chip" style={{ background: STREAM_COLOR }} />
              {STREAM_LABEL}
            </span>
          </div>
        </>
      )}
    </>
  );
}
