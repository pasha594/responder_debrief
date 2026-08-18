/**
 * Time-of-arrival legends, shared verbatim by the Forecast tab and the map's
 * LegendBar so the two can never disagree about what the pixels mean.
 *
 * There is one legend per paint mode:
 *   timeline — the burned / leading-edge pair, captioned with the scrub time.
 *   whole    — the hours-to-arrival bands, straight off the TOA_BANDS table
 *              the renderer paints from.
 */
import type { PyrecastRun } from '../api/types';
import { formatBandLabel, toaLegendBands } from '../spread/toaBands';
import { useStore } from '../state/store';
import { formatDateTime } from '../utils/format';

/** One color chip + its label. */
export function LegendSwatch({ color, label }: { color: string; label: string }) {
  return (
    <span className="rd-swatch">
      <span className="rd-swatch-chip" aria-hidden style={{ background: color }} />
      <span className="rd-swatch-label">{label}</span>
    </span>
  );
}

/** Timeline mode: two swatches + "as of {scrub time}". */
export function ToaTimelineLegend({
  run,
  timezone,
  showCaption = true,
}: {
  run: PyrecastRun;
  timezone: string | null;
  showCaption?: boolean;
}) {
  const currentTime = useStore((s) => s.time.currentTime);
  const stops = new Map(run.toa_ramp?.stops ?? []);
  const burned = stops.get('burned') ?? '#7a1f1f';
  const recent = stops.get('recent') ?? '#ff6a2b';
  const recentHours = run.toa_ramp?.recent_hours ?? 12;
  return (
    <div>
      <div className="rd-swatch-row">
        <LegendSwatch color={recent} label={`Spread in last ${recentHours} h`} />
        <LegendSwatch color={burned} label="Burned earlier" />
      </div>
      {showCaption && (
        <div className="rd-legend-caption">as of {formatDateTime(currentTime, timezone)}</div>
      )}
    </div>
  );
}

/**
 * Whole mode: the band ramp, cool (soonest) → warm (latest). Bands past the
 * run's horizon are dropped and the top band is relabeled to the horizon, so
 * the legend only ever advertises reach the run actually has. `withinHours`
 * dims the bands the reach slider is currently hiding.
 */
export function ToaBandLegend({
  horizonHours,
  withinHours,
}: {
  horizonHours: number;
  withinHours?: number;
}) {
  const bands = toaLegendBands(horizonHours);
  return (
    <div className="rd-band-legend">
      {bands.map((band) => {
        const hidden = withinHours !== undefined && band.hours > withinHours;
        return (
          <span
            key={band.hours}
            className={`rd-swatch${hidden ? ' rd-swatch--off' : ''}`}
            title={hidden ? 'Beyond the current reach — hidden on the map' : undefined}
          >
            <span className="rd-swatch-chip" aria-hidden style={{ background: band.color }} />
            <span className="rd-swatch-label">{formatBandLabel(band.hours)}</span>
          </span>
        );
      })}
    </div>
  );
}
