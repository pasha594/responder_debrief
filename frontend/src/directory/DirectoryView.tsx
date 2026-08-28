/**
 * The app's default view: a full-screen roster of every active fire. No map is
 * mounted here — clicking a row routes to '#/fire/{corneaId}', which swaps in
 * the single-fire map shell.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { DisclaimerFooter } from '../panels/DisclaimerFooter';
import { SettingsControl } from '../panels/SettingsControl';
import { searchPlaces, type PlaceHit } from '../api/geocode';
import { track } from '../app/analytics';
import { useFires, useMasterCatalog } from '../api/queries';
import { useStore } from '../state/store';
import { useIsDesktop } from '../utils/useMediaQuery';
import { DirectoryRow } from './DirectoryRow';
import {
  DIRECTORY_FILTERS,
  NEAR_RADIUS_MI,
  buildDirectoryRows,
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

  const rows = useMemo(
    () => buildDirectoryRows(catalog.data, fires.data),
    [catalog.data, fires.data],
  );
  const summary = useMemo(() => summarizeRows(rows), [rows]);
  // The near pool clones rows (distance attached), so memoize it on
  // [rows, near] alone — recomputing per keystroke would mint new object
  // identities and defeat DirectoryRow's memo.
  const pool = useMemo(() => nearRows(rows, near), [rows, near]);
  const shown = useMemo(
    () => selectDirectoryRows(pool, { query, filter, sort }),
    [pool, query, filter, sort],
  );

  // ---- place autocomplete on the same search box ("Reno" → fires near Reno).
  // Debounced Photon lookup; fire/state filtering stays instant beneath it.
  const [placeHits, setPlaceHits] = useState<PlaceHit[]>([]);
  const [placesOpen, setPlacesOpen] = useState(false);
  const placeSeq = useRef(0);
  // Only geocode once the user actually edits the box in THIS mount — the
  // query survives fire round-trips in the store, and remounting must not
  // re-fire Photon for a search the user already finished.
  const queryTouched = useRef(false);
  useEffect(() => {
    const q = query.trim();
    const mySeq = ++placeSeq.current;
    if (!queryTouched.current || q.length < 3) {
      setPlaceHits([]);
      return;
    }
    const t = setTimeout(() => {
      // biased to the CONUS centroid so "Moscow" means Idaho before Russia
      searchPlaces(q, [-98.6, 39.8])
        .then((hits) => {
          if (mySeq !== placeSeq.current) return;
          setPlaceHits(hits);
        })
        .catch(() => {
          if (mySeq === placeSeq.current) setPlaceHits([]);
        });
    }, 350);
    return () => clearTimeout(t);
  }, [query]);

  const pickPlace = (hit: PlaceHit) => {
    track('place_searched', { kind: hit.kind, context: 'directory' });
    actions.setDirectoryNear({ label: hit.label, coords: hit.coords });
    actions.setDirectoryQuery('');
    setPlaceHits([]);
    setPlacesOpen(false);
  };

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

  // In near mode the Location column carries the distances, so its header
  // sorts by distance (how the roster is ordered on entry) instead of state.
  const columns = useMemo(
    () =>
      near
        ? COLUMNS.map((c) => (c.key === 'state' ? { ...c, key: 'distance' as DirectorySortKey } : c))
        : COLUMNS,
    [near],
  );

  return (
    <div className="rd-directory">
      <header className="rd-dir-header">
        <div className="rd-dir-brand">
          <h1 className="rd-dir-wordmark">Responder Brief</h1>
          <div className="rd-dir-subtitle">{subtitle}</div>
        </div>
        <SettingsControl />
      </header>

      <div className="rd-dir-toolbar">
        <div
          className="rd-dir-searchwrap"
          onBlur={(e) => {
            // close only when focus truly left the wrap (input ↔ hit buttons)
            if (!e.currentTarget.contains(e.relatedTarget as Node)) setPlacesOpen(false);
          }}
        >
          <input
            type="search"
            className="rd-search rd-dir-search"
            placeholder="Search fire, state, or city"
            value={query}
            onChange={(e) => {
              queryTouched.current = true;
              actions.setDirectoryQuery(e.target.value);
            }}
            onFocus={() => setPlacesOpen(true)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setPlacesOpen(false);
              if (e.key === 'ArrowDown') {
                const first = e.currentTarget
                  .closest('.rd-dir-searchwrap')
                  ?.querySelector<HTMLButtonElement>('.rd-dir-placehits button');
                if (first) {
                  e.preventDefault();
                  first.focus();
                }
              }
            }}
            aria-label="Search fires by name, state, or city"
          />
          {placesOpen && placeHits.length > 0 && query.trim().length >= 3 && (
            <ul
              className="rd-place-hits rd-dir-placehits"
              // keep the input focused through hit clicks AND scrollbar drags
              onMouseDown={(e) => {
                if (e.target instanceof HTMLElement && e.target.tagName !== 'BUTTON') {
                  e.preventDefault();
                }
              }}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setPlacesOpen(false);
                  document.querySelector<HTMLInputElement>('.rd-dir-search')?.focus();
                }
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                  e.preventDefault();
                  const btns = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('button')];
                  const i = btns.indexOf(document.activeElement as HTMLButtonElement);
                  const next = btns[i + (e.key === 'ArrowDown' ? 1 : -1)];
                  if (next) next.focus();
                  else if (e.key === 'ArrowUp') {
                    document.querySelector<HTMLInputElement>('.rd-dir-search')?.focus();
                  }
                }
              }}
            >
              <li className="rd-dir-placehead" aria-hidden="true">
                Places — show fires nearby
              </li>
              {placeHits.map((h, i) => (
                <li key={`${h.label}-${i}`}>
                  <button type="button" onClick={() => pickPlace(h)}>
                    {h.label}
                    {h.detail && <span className="rd-place-detail">{h.detail}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        {near && (
          <button
            type="button"
            className="rd-chip rd-chip--active rd-near-chip"
            title={`Fires within ${NEAR_RADIUS_MI} miles, closest first — click to clear`}
            onClick={() => actions.setDirectoryNear(null)}
          >
            Near {near.label} <span aria-hidden="true">✕</span>
          </button>
        )}
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
            {near && pool.length === 0
              ? `No fires within ${NEAR_RADIUS_MI} miles of ${near.label}.`
              : near
                ? `No fires near ${near.label} match this search.`
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
