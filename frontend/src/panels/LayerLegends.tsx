/**
 * Keys for the Layers tab's own layers, shared by each layer's row and the
 * map's key (LegendBar) so the two can never disagree — the same pattern as
 * VegetationLegend and IrHeatLegend. Colors come from the layers themselves.
 */
import { useMemo } from 'react';
import { LAND_CLASSES, landChipStyle } from '../api/nifcLandStatus';
import { useFireLandStatus } from '../api/queries';
import { AGE_ORANGE, AGE_PURPLE, AGE_YELLOW } from '../map/layers/hotspotLayer';
import { TRAIL_PAINT } from '../map/layers/trailsStyle';

/** Hotspot dots by age at the playhead (hotspotLayer's ramp). */
export function HotspotAgeLegend() {
  return (
    <div className="rd-hist-legend" aria-hidden="true">
      <span className="rd-hist-chip rd-hist-chip--dot" style={{ background: AGE_YELLOW }} /> new
      <span className="rd-hist-chip rd-hist-chip--dot" style={{ background: AGE_ORANGE }} /> 1 day
      <span className="rd-hist-chip rd-hist-chip--dot" style={{ background: AGE_PURPLE }} /> 2 days
    </div>
  );
}

/** The perimeter layer's one symbol: red line round a faint red fill. */
export function PerimeterChip() {
  return <span className="rd-perimeter-chip" aria-hidden="true" />;
}

export function HistoricPerimetersLegend() {
  return (
    <div className="rd-hist-legend" aria-hidden="true">
      <span className="rd-hist-chip" style={{ background: '#e0a24a' }} /> recent
      <span className="rd-hist-chip" style={{ background: '#a5875a' }} /> ~5 yr
      <span className="rd-hist-chip" style={{ background: '#6f675f' }} /> 10 yr
    </div>
  );
}

export function TrailsLegend() {
  return (
    <div className="rd-hist-legend" aria-hidden="true">
      <span className="rd-hist-chip" style={{ background: TRAIL_PAINT.topo.core }} /> trail
      <span className="rd-hist-chip" style={{ background: TRAIL_PAINT.topo.core, opacity: 0.55 }} /> not
      assessed (BLM)
    </div>
  );
}

/** The agencies actually in view around this fire, in NIFC's colors, then
 * private land (unshaded) — or where the download stands. */
export function LandLegend({ corneaId }: { corneaId: string }) {
  const { data, isLoading, isError, bbox } = useFireLandStatus(corneaId, true);
  const present = useMemo(() => {
    const cats = new Set(data?.features.map((f) => f.properties.JurisdictionalCategory));
    return LAND_CLASSES.filter((c) => c.codes.some((code) => cats.has(code)));
  }, [data]);
  if (!bbox) return null; // no known origin to look around
  if (isError) return <div className="rd-land-legend">Couldn't reach NIFC — needs a connection</div>;
  if (isLoading || !data) return <div className="rd-land-legend">Loading land status…</div>;
  return (
    <div className="rd-land-legend" aria-hidden="true">
      {present.map((c) => (
        <span key={c.label} className="rd-land-key">
          <span className="rd-hist-chip" style={landChipStyle(c)} />
          {c.label}
        </span>
      ))}
      <span className="rd-land-key">
        <span className="rd-hist-chip rd-land-chip--private" />
        Private
      </span>
    </div>
  );
}
