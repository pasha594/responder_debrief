/**
 * The app's default view: a full-screen roster of every active fire. No map is
 * mounted here — clicking a row routes to '#/fire/{corneaId}', which swaps in
 * the single-fire map shell.
 */
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { HREF_HEALTH } from '../app/router';
import { useFires, useMasterCatalog } from '../api/queries';
import { useStore } from '../state/store';
import { useIsDesktop } from '../utils/useMediaQuery';
import { DirectoryRow } from './DirectoryRow';
import {
  DIRECTORY_FILTERS,
  buildDirectoryRows,
  selectDirectoryRows,
  summarizeRows,
  type DirectorySortKey,
} from './rowModel';
import './directory.css';

const COLUMNS: { key: DirectorySortKey; label: string; className: string }[] = [
  { key: 'name', label: 'Fire', className: 'rd-dir-c-fire' },
  { key: 'state', label: 'Location', className: 'rd-dir-c-loc' },
  { key: 'acres', label: 'Size', className: 'rd-dir-c-num' },
  { key: 'started', label: 'Started', className: 'rd-dir-c-started' },
  { key: 'perimeter', label: 'Perimeter', className: 'rd-dir-c-perim' },
  { key: 'forecast', label: 'Forecast', className: 'rd-dir-c-fcst' },
  { key: 'files', label: 'FTP files', className: 'rd-dir-c-ftp' },
];

/** Survives the map round-trip so returning lands where the user left off. */
let savedScrollTop = 0;

function SkeletonRows({ desktop }: { desktop: boolean }) {
  const bars = Array.from({ length: 12 }, (_, i) => i);
  if (!desktop) {
    return (
      <ul className="rd-dir-cards">
        {bars.map((i) => (
          <li key={i} className="rd-dir-card rd-dir-card--skeleton">
            <div className="rd-skel rd-skel--title" />
            <div className="rd-skel rd-skel--meta" />
          </li>
        ))}
      </ul>
    );
  }
  return (
    <tbody>
      {bars.map((i) => (
        <tr key={i} className="rd-dir-row rd-dir-row--skeleton">
          {COLUMNS.map((c) => (
            <td key={c.key} className={c.className}>
              <div className="rd-skel" />
            </td>
          ))}
        </tr>
      ))}
    </tbody>
  );
}

function ThemeToggle() {
  const theme = useStore((s) => s.ui.theme);
  const setTheme = useStore((s) => s.actions.setTheme);
  const next = theme === 'dark' ? 'light' : 'dark';
  return (
    <button
      type="button"
      className="rd-mini-btn rd-dir-theme"
      onClick={() => setTheme(next)}
      aria-label={`Switch to ${next} theme`}
      title={`Switch to ${next} theme`}
    >
      {theme === 'dark' ? '☀ Light' : '☾ Dark'}
    </button>
  );
}

export function DirectoryView() {
  const fires = useFires();
  const catalog = useMasterCatalog();
  const nowMs = useStore((s) => s.time.now);
  const { query, filter, sort } = useStore((s) => s.ui.directory);
  const actions = useStore((s) => s.actions);
  const isDesktop = useIsDesktop();
  const scrollRef = useRef<HTMLDivElement>(null);

  const rows = useMemo(
    () => buildDirectoryRows(catalog.data, fires.data),
    [catalog.data, fires.data],
  );
  const summary = useMemo(() => summarizeRows(rows), [rows]);
  const shown = useMemo(
    () => selectDirectoryRows(rows, { query, filter, sort }),
    [rows, query, filter, sort],
  );

  // Restore the roster scroll position when coming back from a fire.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && savedScrollTop) el.scrollTop = savedScrollTop;
  }, []);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      savedScrollTop = el.scrollTop;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  const loading = fires.isLoading || catalog.isLoading;
  const failed = fires.isError && catalog.isError;
  const hasRows = rows.length > 0;

  const nf = (n: number) => n.toLocaleString('en-US');
  const subtitle = hasRows
    ? `${nf(summary.active)} active fires · ${nf(summary.withForecast)} with forecasts · ${nf(summary.withIncidentMaps)} with incident maps`
    : loading
      ? 'Loading the national roster…'
      : 'No fires listed';

  const open = actions.selectFire;

  return (
    <div className="rd-directory">
      <header className="rd-dir-header">
        <div className="rd-dir-brand">
          <h1 className="rd-dir-wordmark">Responder Brief</h1>
          <a href={HREF_HEALTH} className="rd-dir-health-link" title="Ingestion health">
            Health
          </a>
          <div className="rd-dir-subtitle">{subtitle}</div>
        </div>
        <ThemeToggle />
      </header>

      <div className="rd-dir-toolbar">
        <input
          type="search"
          className="rd-search rd-dir-search"
          placeholder="Search fire or state"
          value={query}
          onChange={(e) => actions.setDirectoryQuery(e.target.value)}
          aria-label="Search fires by name or state"
        />
        <div className="rd-chips" role="group" aria-label="Filter fires">
          {DIRECTORY_FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              className={`rd-chip${filter === f.id ? ' rd-chip--active' : ''}`}
              aria-pressed={filter === f.id}
              onClick={() => actions.setDirectoryFilter(f.id)}
            >
              {f.label}
            </button>
          ))}
        </div>
        {hasRows && (
          <div className="rd-dir-count">
            {nf(shown.length)}
            {shown.length === rows.length ? '' : ` of ${nf(rows.length)}`} shown
          </div>
        )}
      </div>

      <div className="rd-dir-scroll" ref={scrollRef}>
        {failed && (
          <div className="rd-empty">
            Could not load the fire index or the catalog. Check the connection and reload.
          </div>
        )}

        {!failed && isDesktop && (
          <table className="rd-dir-table">
            <thead>
              <tr>
                {COLUMNS.map((c) => {
                  const active = sort.key === c.key;
                  return (
                    <th
                      key={c.key}
                      className={c.className}
                      scope="col"
                      aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                    >
                      <button
                        type="button"
                        className={`rd-dir-th${active ? ' rd-dir-th--active' : ''}`}
                        onClick={() => actions.toggleDirectorySort(c.key)}
                      >
                        {c.label}
                        <span className="rd-dir-arrow" aria-hidden="true">
                          {active ? (sort.dir === 'asc' ? '▲' : '▼') : ''}
                        </span>
                      </button>
                    </th>
                  );
                })}
              </tr>
            </thead>
            {loading && !hasRows ? (
              <SkeletonRows desktop />
            ) : (
              <tbody>
                {shown.map((r) => (
                  <DirectoryRow
                    key={r.corneaId}
                    row={r}
                    nowMs={nowMs}
                    variant="row"
                    onOpen={open}
                  />
                ))}
              </tbody>
            )}
          </table>
        )}

        {!failed && !isDesktop && (
          loading && !hasRows ? (
            <SkeletonRows desktop={false} />
          ) : (
            <ul className="rd-dir-cards">
              {shown.map((r) => (
                <DirectoryRow
                  key={r.corneaId}
                  row={r}
                  nowMs={nowMs}
                  variant="card"
                  onOpen={open}
                />
              ))}
            </ul>
          )
        )}

        {!failed && !loading && hasRows && shown.length === 0 && (
          <div className="rd-empty">No fires match this search.</div>
        )}
        {!failed && !loading && !hasRows && (
          <div className="rd-empty">No active fires are listed right now.</div>
        )}
      </div>
    </div>
  );
}
