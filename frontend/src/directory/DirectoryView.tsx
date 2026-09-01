/**
 * The app's default view: a full-screen roster of every active fire. No map is
 * mounted here — clicking a row routes to '#/fire/{corneaId}', which swaps in
 * the single-fire map shell.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { DisclaimerFooter } from '../panels/DisclaimerFooter';
import { SettingsControl } from '../panels/SettingsControl';
import { OfflineFiresStrip } from './OfflineFiresStrip';
import { pickBestCity, searchPlaces } from '../api/geocode';
import { track } from '../app/analytics';
import { useFires, useMasterCatalog } from '../api/queries';
import { useStore } from '../state/store';
import { useIsDesktop } from '../utils/useMediaQuery';
import { DirectoryRow } from './DirectoryRow';
import {
  DIRECTORY_FILTERS,
  NEAR_RADIUS_MI,
  buildDirectoryRows,
  matchesQuery,
  nearRows,
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

/** Queries Photon already answered with "no US city" — never re-asked. */
const nilCityQueries = new Set<string>();

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


export function DirectoryView() {
  const fires = useFires();
  const catalog = useMasterCatalog();
  const nowMs = useStore((s) => s.time.now);
  const { query, filter, sort, near } = useStore((s) => s.ui.directory);
  const actions = useStore((s) => s.actions);
  const isDesktop = useIsDesktop();
  const scrollRef = useRef<HTMLDivElement>(null);

  const online = useStore((s) => s.offline.online);
  const packs = useStore((s) => s.offline.packs);
  const allRows = useMemo(
    () => buildDirectoryRows(catalog.data, fires.data),
    [catalog.data, fires.data],
  );
  // No service: the roster is a stale snapshot and only downloaded fires can
  // actually open — show just those.
  const rows = useMemo(() => {
    if (online) return allRows;
    const downloaded = new Set(Object.keys(packs));
    return allRows.filter((r) => r.fireSlug && downloaded.has(r.fireSlug));
  }, [allRows, online, packs]);
  const summary = useMemo(() => summarizeRows(rows), [rows]);

  // Match priority: fire names and states filter instantly as you type…
  const direct = useMemo(
    () => selectDirectoryRows(rows, { query, filter, sort }),
    [rows, query, filter, sort],
  );
  const q = query.trim().toLowerCase();
  // Mode is decided by name/state matching ALONE — the filter chips filter
  // within whichever mode is active, they must never flip it (or lie about
  // why nothing matched).
  const hasDirect = useMemo(
    () => q.length === 0 || rows.some((r) => matchesQuery(r, q)),
    [rows, q],
  );

  // …and when nothing matches, the query resolves to the biggest US city
  // with that name in the background (see the effect below); the roster then
  // shows fires near it. Entry sorts closest-first via setDirectoryNear; the
  // column headers re-sort the near pool like any other roster. The pool
  // memoizes on [rows, near] because it clones rows (DirectoryRow's memo
  // lives on row identity).
  const cityMode = !hasDirect && near != null && near.query === q;
  const pool = useMemo(() => nearRows(rows, near), [rows, near]);
  const nearShown = useMemo(
    () => selectDirectoryRows(pool, { query: '', filter, sort }),
    [pool, filter, sort],
  );
  const shown = cityMode ? nearShown : direct;

  // ---- background city resolution. One debounced Photon request per
  // settled no-match query; a resolved place is remembered in the store
  // (keyed by its query) so fire round-trips replay it with zero requests.
  const [resolving, setResolving] = useState(false);
  const placeSeq = useRef(0);
  useEffect(() => {
    const mySeq = ++placeSeq.current;
    if (
      hasDirect ||
      q.length < 3 ||
      rows.length === 0 ||
      near?.query === q || // already resolved (or restored from the store)
      nilCityQueries.has(q) // known to resolve to nothing — don't re-ask
    ) {
      setResolving(false);
      return;
    }
    setResolving(true);
    const t = setTimeout(() => {
      searchPlaces(q)
        .then((hits) => {
          if (mySeq !== placeSeq.current) return;
          setResolving(false);
          const best = pickBestCity(hits);
          if (best) {
            track('place_searched', { kind: best.kind, context: 'directory' });
            actions.setDirectoryNear({
              query: q,
              label: best.state ? `${best.label}, ${best.state}` : best.label,
              coords: best.coords,
            });
          } else {
            nilCityQueries.add(q);
            if (useStore.getState().ui.directory.near) actions.setDirectoryNear(null);
          }
        })
        .catch(() => {
          // transient — retried on the next edit or remount
          if (mySeq === placeSeq.current) setResolving(false);
        });
    }, 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, hasDirect, rows.length, near?.query]);

  // A cleared box means no city fallback lingering for next time.
  useEffect(() => {
    if (q.length === 0 && near) actions.setDirectoryNear(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

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

  // In city mode the Location column carries the distances, so its header
  // sorts by distance (the entry order) instead of state.
  const columns = useMemo(
    () =>
      cityMode
        ? COLUMNS.map((c) => (c.key === 'state' ? { ...c, key: 'distance' as DirectorySortKey } : c))
        : COLUMNS,
    [cityMode],
  );

  return (
    <div className="rd-directory">
      <header className="rd-dir-header">
        <div className="rd-dir-brand">
          <h1 className="rd-dir-wordmark">Responder Brief</h1>
          {/* On-page copy of the meta description: search engines prefer
              prominent prose near the top over footer boilerplate. */}
          <p className="rd-dir-tagline">
            Wildfire situational awareness for responders: incident maps, perimeters,
            hotspots, and forecasts all in one place.
          </p>
          <div className="rd-dir-subtitle">{subtitle}</div>
        </div>
        <SettingsControl />
      </header>

      {!online && (
        <div className="rd-offline-note-line">
          No service — showing fires downloaded on this device.
        </div>
      )}
      <OfflineFiresStrip />

      <div className="rd-dir-toolbar">
        <input
          type="search"
          className="rd-search rd-dir-search"
          placeholder="Search fire, state, or city"
          value={query}
          onChange={(e) => actions.setDirectoryQuery(e.target.value)}
          aria-label="Search fires by name, state, or city"
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

      {cityMode && shown.length > 0 && (
        <div className="rd-dir-nearline">
          No fire or state names match “{query.trim()}” — showing fires within{' '}
          {NEAR_RADIUS_MI} mi of <strong>{near.label}</strong>, closest first.
        </div>
      )}

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
                {columns.map((c) => {
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
          <div className="rd-empty">
            {resolving
              ? `No fire or state names match — checking cities…`
              : cityMode && pool.length === 0
                ? `No fires within ${NEAR_RADIUS_MI} miles of ${near.label}.`
                : cityMode
                  ? `No fires near ${near.label} match these filters.`
                  : 'No fires match this search.'}
          </div>
        )}
        {!failed && !loading && !hasRows && (
          <div className="rd-empty">No active fires are listed right now.</div>
        )}
        <DisclaimerFooter />
      </div>
    </div>
  );
}
