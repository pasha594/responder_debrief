/** One row in the national fire list. */
import type { FireSummary } from '../api/types';
import { formatAcres, formatPct } from '../utils/format';

/** Tiny containment progress ring (SVG, token-colored). */
function ContainmentRing({ pct }: { pct: number | null }) {
  const r = 6.5;
  const c = 2 * Math.PI * r;
  const frac = pct == null ? 0 : Math.min(100, Math.max(0, pct)) / 100;
  return (
    <svg className="rd-ring" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r={r} fill="none" stroke="var(--color-border)" strokeWidth="2.5" />
      <circle
        cx="8"
        cy="8"
        r={r}
        fill="none"
        stroke="var(--color-accent)"
        strokeWidth="2.5"
        strokeDasharray={`${c * frac} ${c}`}
        strokeLinecap="round"
        transform="rotate(-90 8 8)"
      />
    </svg>
  );
}

export function FireListItem({
  fire,
  onSelect,
}: {
  fire: FireSummary;
  onSelect: (corneaId: string) => void;
}) {
  const prescribed = fire.firetype === 'Prescribed Fire';
  return (
    <button
      type="button"
      className="rd-fire-item"
      onClick={() => onSelect(fire.cornea_id)}
      title={fire.post_title}
    >
      <div className="rd-fire-item-main">
        <span className="rd-fire-item-name">{fire.post_title}</span>
        {prescribed && <span className="rd-badge rd-badge-muted">Rx</span>}
      </div>
      <div className="rd-fire-item-meta">
        <span>{fire.state}</span>
        <span className="rd-dot-sep">•</span>
        <span>{formatAcres(fire.acres)}</span>
        <span className="rd-dot-sep">•</span>
        <span className="rd-fire-item-contain">
          <ContainmentRing pct={fire.containment} />
          {formatPct(fire.containment)}
        </span>
      </div>
    </button>
  );
}
