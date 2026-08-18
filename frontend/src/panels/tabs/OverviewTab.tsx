/** Fire overview: stats, detail rows, AI summary, structure exposure. */
import { useFire } from '../../api/queries';
import type { StructureExposureBuffer } from '../../api/types';
import { formatRelative } from '../../utils/format';
import { useImsr, useMasterCatalog } from '../../api/queries';
import { Markdown } from '../../utils/markdown';

function formatCount(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return Math.round(n).toLocaleString('en-US');
}

function KvRow({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;
  return (
    <div className="rd-kv">
      <span className="rd-kv-label">{label}</span>
      <span className="rd-kv-value">{value}</span>
    </div>
  );
}

/**
 * Daily resources & operations from the NIFC sit report (IMSR) — the public
 * ICS-209 numbers responders asked for: resource types, personnel trend,
 * estimated containment, plus the narrative (team, behavior, threats).
 */
function ImsrSection({ fireSlug }: { fireSlug: string | null }) {
  const { data: imsr } = useImsr();
  const entry = fireSlug ? imsr?.fires?.[fireSlug] : undefined;
  if (!entry) return null;
  const stat = (v: number | null) => (v == null ? '—' : v.toLocaleString('en-US'));
  const delta =
    entry.personnel_change == null || entry.personnel_change === 0
      ? null
      : `${entry.personnel_change > 0 ? '+' : ''}${entry.personnel_change} today`;
  return (
    <section className="rd-section">
      <h3 className="rd-section-title">
        Resources &amp; Operations
        <span className="rd-title-meta">national sit report, daily</span>
      </h3>
      <div className="rd-stats-strip">
        <div className="rd-stat">
          <span className="rd-stat-value">{stat(entry.crews)}</span>
          <span className="rd-stat-label">Crews</span>
        </div>
        <div className="rd-stat">
          <span className="rd-stat-value">{stat(entry.engines)}</span>
          <span className="rd-stat-label">Engines</span>
        </div>
        <div className="rd-stat">
          <span className="rd-stat-value">{stat(entry.helicopters)}</span>
          <span className="rd-stat-label">Helicopters</span>
        </div>
        <div className="rd-stat">
          <span className="rd-stat-value">{stat(entry.personnel)}</span>
          <span className="rd-stat-label">{delta ? `Pers. ${delta}` : 'Personnel'}</span>
        </div>
      </div>
      <div className="rd-kv-list">
        {entry.est_containment && (
          <KvRow label="Est. containment" value={entry.est_containment} />
        )}
        <KvRow label="Cost to date" value={entry.cost_to_date ? `$${entry.cost_to_date}` : null} />
        {entry.structures_lost != null && entry.structures_lost > 0 && (
          <KvRow label="Structures lost" value={String(entry.structures_lost)} />
        )}
      </div>
      {entry.narrative && <p className="rd-imsr-narrative">{entry.narrative}</p>}
    </section>
  );
}

function ExposureTable({ buffers }: { buffers: StructureExposureBuffer[] }) {
  if (!buffers.length) return null;
  return (
    <section className="rd-section">
      <h3 className="rd-section-title">Structure Exposure</h3>
      <div className="rd-table-wrap">
        <table className="rd-exposure-table">
          <thead>
            <tr>
              <th>Buffer</th>
              <th>Population</th>
              <th>Buildings</th>
              <th>Hospitals</th>
            </tr>
          </thead>
          <tbody>
            {buffers.map((b) => (
              <tr key={b.buffer_miles}>
                <td>{b.buffer_miles} mi</td>
                <td>{formatCount(b.population)}</td>
                <td>{formatCount(b.buildings)}</td>
                <td>{formatCount(b.hospitals)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function OverviewTab({ corneaId }: { corneaId: string }) {
  const { data: fire, isLoading } = useFire(corneaId);
  const { data: catalog } = useMasterCatalog();
  const fireSlug =
    catalog?.fires.find((f) => f.cornea_id === corneaId)?.fire_slug ??
    fire?.unique_slug ??
    null;

  if (isLoading || !fire) {
    return <div className="rd-empty">{isLoading ? 'Loading…' : 'Fire not found.'}</div>;
  }

  return (
    <div className="rd-tab-body">
      <div className="rd-kv-list">
        <KvRow label="Cause" value={fire.cause ?? fire.general_cause} />
        <KvRow label="Fuel" value={fire.primary_fuel_group} />
        <KvRow label="County" value={fire.county} />
        <KvRow label="Behavior" value={fire.general_behavior} />
        <KvRow label="Complexity" value={fire.complexity_type} />
      </div>

      <ImsrSection fireSlug={fireSlug} />

      {fire.structure_exposure && <ExposureTable buffers={fire.structure_exposure.buffers} />}

      {fire.latest_summary && (
        <section className="rd-ai-card">
          <div className="rd-ai-head">
            AI summary • {formatRelative(fire.latest_summary.created_at)}
          </div>
          <Markdown>{fire.latest_summary.summary_text}</Markdown>
          <div className="rd-disclaimer">AI-generated from official sources</div>
        </section>
      )}

      {fire.inciweb?.incident_url && (
        <a
          className="rd-ext-link"
          href={fire.inciweb.incident_url}
          target="_blank"
          rel="noopener noreferrer"
        >
          View on InciWeb ↗
        </a>
      )}
    </div>
  );
}
