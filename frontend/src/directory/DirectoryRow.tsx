/**
 * One fire in the directory. Renders as a table row on desktop and as a
 * stacked card on mobile — same derived values, two shells. Memoized: the
 * roster is ~400 rows and re-renders on every keystroke in the search box.
 */
import { memo, type KeyboardEvent } from 'react';
import { daysSince, formatAcres, formatDay, formatPct, formatRelative } from '../utils/format';
import { perimeterFreshness, type DirectoryRow as Row } from './rowModel';

/** Tiny containment progress ring (SVG, token-colored). */
function ContainmentRing({ pct }: { pct: number | null }) {
  const r = 5.5;
  const c = 2 * Math.PI * r;
  const frac = pct == null ? 0 : Math.min(100, Math.max(0, pct)) / 100;
  return (
    <svg className="rd-ring" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <circle cx="7" cy="7" r={r} fill="none" stroke="var(--color-border)" strokeWidth="2.5" />
      <circle
        cx="7"
        cy="7"
        r={r}
        fill="none"
        stroke="var(--color-accent)"
        strokeWidth="2.5"
        strokeDasharray={`${c * frac} ${c}`}
        strokeLinecap="round"
        transform="rotate(-90 7 7)"
      />
    </svg>
  );
}

const DASH = '—';

interface Cells {
  started: string;
  age: string | null;
  perimeter: string;
  perimeterClass: string;
  perimeterTitle: string | undefined;
  perimeterSub: string | null;
  forecastRun: string | null;
  forecastClass: string;
  forecastTitle: string | undefined;
  forecastSub: string | null;
  ftp: string | null;
  ftpClass: string;
  ftpSub: string | null;
  files: string;
}

function cells(row: Row, nowMs: number): Cells {
  const days = daysSince(row.createdOn, nowMs);
  const bucket = perimeterFreshness(row.polyLastUpdated, nowMs);
  // Prefer the full upload timestamp; date-only values parse as UTC midnight.
  const ftpTs = row.latestUploadTs ?? row.latestUpload;
  // A fire can be mirrored before its counts are known (a run that skipped it
  // as unchanged records no map_count). "—" would read as "no maps", so show a
  // check until the next catalog sync backfills the number.
  const files =
    row.mapCount || row.irCount
      ? `${row.mapCount}${row.irCount ? ` · ${row.irCount} IR` : ''}`
      : row.hasIncidentMaps
        ? '✓'
        : DASH;
  return {
    started: formatDay(row.createdOn, null, nowMs),
    age: days == null ? null : `${days} ${days === 1 ? 'day' : 'days'}`,
    perimeter: row.polyLastUpdated ? formatRelative(row.polyLastUpdated, nowMs) : DASH,
    perimeterClass: `rd-dir-fresh rd-dir-fresh--${bucket}`,
    perimeterTitle: row.polyLastUpdated
      ? `Newest perimeter ${new Date(row.polyLastUpdated).toISOString().replace('T', ' ').slice(0, 16)} UTC`
      : undefined,
    perimeterSub:
      row.perimeterCount != null && row.perimeterCount > 0
        ? `${row.perimeterCount} ${row.perimeterCount === 1 ? 'version' : 'versions'}`
        : null,
    forecastRun: row.hasForecast
      ? row.spreadLatestRun
        ? formatRelative(row.spreadLatestRun, nowMs)
        : 'available'
      : null,
    forecastClass: `rd-dir-fresh rd-dir-fresh--${perimeterFreshness(row.spreadLatestRun, nowMs)}`,
    forecastTitle: row.spreadLatestRun
      ? `Latest forecast run ${new Date(row.spreadLatestRun).toISOString().replace('T', ' ').slice(0, 16)} UTC`
      : undefined,
    forecastSub:
      row.spreadRunCount != null && row.spreadRunCount > 0
        ? `${row.spreadRunCount} ${row.spreadRunCount === 1 ? 'run' : 'runs'}`
        : null,
    ftp: ftpTs ? formatRelative(ftpTs, nowMs) : null,
    ftpClass: `rd-dir-fresh rd-dir-fresh--${perimeterFreshness(ftpTs, nowMs)}`,
    ftpSub:
      row.mapCount || row.irCount
        ? `${row.mapCount} ${row.mapCount === 1 ? 'file' : 'files'}` +
          (row.irCount ? ` · ${row.irCount} IR` : '')
        : null,
    files,
  };
}

function FireName({ row }: { row: Row }) {
  return (
    <>
      <span className="rd-dir-name">{row.name}</span>
      {row.prescribed && <span className="rd-badge rd-badge-muted">Rx</span>}
    </>
  );
}

function Containment({ row }: { row: Row }) {
  if (row.containment == null) return null;
  return (
    <span className="rd-dir-contain">
      <ContainmentRing pct={row.containment} />
      {formatPct(row.containment)} contained
    </span>
  );
}

// Same presentation as the perimeter cell: relative age, freshness-colored,
// with the run count beneath in the sub style.
function ForecastCell({ c }: { c: Cells }) {
  if (!c.forecastRun) return <span className="rd-muted">{DASH}</span>;
  return (
    <>
      <span className={c.forecastClass} title={c.forecastTitle}>
        {c.forecastRun}
      </span>
      {c.forecastSub && <div className="rd-dir-sub">{c.forecastSub}</div>}
    </>
  );
}

export interface DirectoryRowProps {
  row: Row;
  nowMs: number;
  variant: 'row' | 'card';
  onOpen: (corneaId: string) => void;
}

function DirectoryRowImpl({ row, nowMs, variant, onOpen }: DirectoryRowProps) {
  const c = cells(row, nowMs);
  const open = () => onOpen(row.corneaId);
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      open();
    }
  };
  const shared = {
    tabIndex: 0,
    onClick: open,
    onKeyDown,
    title: `${row.name} — open map view`,
    'aria-label': `${row.name}, ${row.state}, ${formatAcres(row.acres)}`,
  };

  if (variant === 'card') {
    return (
      <li className="rd-dir-card" role="button" {...shared}>
        <div className="rd-dir-card-top">
          <FireName row={row} />
          <span className="rd-dir-card-size">{formatAcres(row.acres)}</span>
        </div>
        <div className="rd-dir-card-meta">
          <span>{row.state || DASH}</span>
          <span className="rd-dot-sep">•</span>
          <span>
            {c.started}
            {c.age ? ` (${c.age})` : ''}
          </span>
          <span className="rd-dot-sep">•</span>
          <span className={c.perimeterClass} title={c.perimeterTitle}>
            perim {c.perimeter}
          </span>
          {row.hasForecast && (
            <>
              <span className="rd-dot-sep">•</span>
              <span className="rd-dir-yes" title="Pyrecast spread forecast available">
                <span className="rd-dir-check" aria-hidden="true">
                  ✓
                </span>
                forecast
              </span>
            </>
          )}
          {c.files !== DASH && (
            <>
              <span className="rd-dot-sep">•</span>
              <span>{c.files} files</span>
            </>
          )}
        </div>
      </li>
    );
  }

  return (
    <tr className="rd-dir-row" {...shared}>
      <td className="rd-dir-c-fire">
        <div className="rd-dir-fire-main">
          <FireName row={row} />
        </div>
        <Containment row={row} />
      </td>
      <td className="rd-dir-c-loc">{row.state || DASH}</td>
      <td className="rd-dir-c-num">{formatAcres(row.acres)}</td>
      <td className="rd-dir-c-started">
        {c.started}
        {c.age && <span className="rd-dir-sub"> ({c.age})</span>}
      </td>
      <td className="rd-dir-c-perim">
        <span className={c.perimeterClass} title={c.perimeterTitle}>
          {c.perimeter}
        </span>
        {c.perimeterSub && <div className="rd-dir-sub">{c.perimeterSub}</div>}
      </td>
      <td className="rd-dir-c-fcst">
        <ForecastCell c={c} />
      </td>
      <td className="rd-dir-c-ftp">
        {!c.ftp && c.files === DASH ? (
          <span className="rd-muted">{DASH}</span>
        ) : (
          <>
            <span className={c.ftp ? c.ftpClass : 'rd-dir-files'}>{c.ftp ?? c.files}</span>
            {c.ftpSub && <div className="rd-dir-sub">{c.ftpSub}</div>}
          </>
        )}
      </td>
    </tr>
  );
}

export const DirectoryRow = memo(DirectoryRowImpl);
