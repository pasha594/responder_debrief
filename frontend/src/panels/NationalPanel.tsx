/** National view: active-fire list with search, filter chips and sorting. */
import { useMemo, useState } from 'react';
import { useFires } from '../api/queries';
import { useActions } from '../state/store';
import type { FireSummary } from '../api/types';
import { formatAcres } from '../utils/format';
import { FireListItem } from './FireListItem';

type Chip = 'all' | 'large' | 'uncontained';
type Sort = 'acres' | 'recent';

const CHIPS: { id: Chip; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'large', label: '>1000 acres' },
  { id: 'uncontained', label: '<50% contained' },
];

function matchesChip(fire: FireSummary, chip: Chip): boolean {
  if (chip === 'large') return (fire.acres ?? 0) > 1000;
  if (chip === 'uncontained') return (fire.containment ?? 0) < 50;
  return true;
}

export function NationalPanel() {
  const { data, isLoading, isError } = useFires();
  const actions = useActions();
  const [search, setSearch] = useState('');
  const [chip, setChip] = useState<Chip>('all');
  const [sort, setSort] = useState<Sort>('acres');

  const fires = data?.fires;
  const totalAcres = useMemo(
    () => fires?.reduce((sum, f) => sum + (f.acres ?? 0), 0) ?? 0,
    [fires],
  );

  const shown = useMemo(() => {
    if (!fires) return [];
    const q = search.trim().toLowerCase();
    const filtered = fires.filter(
      (f) =>
        matchesChip(f, chip) &&
        (!q ||
          f.post_title.toLowerCase().includes(q) ||
          f.state.toLowerCase().includes(q)),
    );
    return filtered.sort((a, b) =>
      sort === 'acres'
        ? (b.acres ?? -1) - (a.acres ?? -1)
        : Date.parse(b.last_updated) - Date.parse(a.last_updated),
    );
  }, [fires, search, chip, sort]);

  return (
    <div className="rd-panel">
      <header className="rd-panel-header">
        <h2 className="rd-panel-title">Active fires</h2>
        {fires && (
          <div className="rd-panel-subtitle">
            {fires.length.toLocaleString('en-US')} fires • {formatAcres(totalAcres)}
          </div>
        )}
      </header>

      <div className="rd-natl-controls">
        <input
          type="search"
          className="rd-search"
          placeholder="Search by name or state"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search fires"
        />
        <div className="rd-chips" role="group" aria-label="Filter fires">
          {CHIPS.map((c) => (
            <button
              key={c.id}
              type="button"
              className={`rd-chip${chip === c.id ? ' rd-chip--active' : ''}`}
              aria-pressed={chip === c.id}
              onClick={() => setChip(c.id)}
            >
              {c.label}
            </button>
          ))}
          <select
            className="rd-sort"
            value={sort}
            onChange={(e) => setSort(e.target.value as Sort)}
            aria-label="Sort fires"
          >
            <option value="acres">Sort: acres</option>
            <option value="recent">Sort: recent update</option>
          </select>
        </div>
      </div>

      <div className="rd-panel-scroll">
        {isLoading && <div className="rd-empty">Loading fires…</div>}
        {isError && <div className="rd-empty">Could not load the fire index.</div>}
        {!isLoading && !isError && shown.length === 0 && (
          <div className="rd-empty">No fires match.</div>
        )}
        {shown.map((f) => (
          <FireListItem key={f.cornea_id} fire={f} onSelect={actions.selectFire} />
        ))}
      </div>
    </div>
  );
}
