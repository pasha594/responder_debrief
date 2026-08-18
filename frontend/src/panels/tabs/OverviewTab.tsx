/** Fire overview: stats, detail rows, AI summary, structure exposure. */
import { useFire } from '../../api/queries';
import type { StructureExposureBuffer } from '../../api/types';
import { formatAcresValue, formatPct, formatRelative } from '../../utils/format';
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

function ExposureTable({ buffers }: { buffers: StructureExposureBuffer[] }) {
  if (!buffers.length) return null;
  return (
    <section className="rd-section">
      <h3 className="rd-section-title">Structure exposure</h3>
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

  if (isLoading || !fire) {
    return <div className="rd-empty">{isLoading ? 'Loading…' : 'Fire not found.'}</div>;
  }

  const days = fire.days != null && Number.isFinite(fire.days) ? String(fire.days) : '—';
  const personnel =
    fire.personnel != null && Number.isFinite(fire.personnel)
      ? fire.personnel.toLocaleString('en-US')
      : '—';

  return (
    <div className="rd-tab-body">
      <div className="rd-stat-grid">
        <div className="rd-stat">
          <span className="rd-stat-value">{formatAcresValue(fire.acres)}</span>
          <span className="rd-stat-label">Acres</span>
        </div>
        <div className="rd-stat">
          <span className="rd-stat-value">{formatPct(fire.containment)}</span>
          <span className="rd-stat-label">Contained</span>
        </div>
        <div className="rd-stat">
          <span className="rd-stat-value">{personnel}</span>
          <span className="rd-stat-label">Personnel</span>
        </div>
        <div className="rd-stat">
          <span className="rd-stat-value">{days}</span>
          <span className="rd-stat-label">Days</span>
        </div>
      </div>

      <div className="rd-kv-list">
        <KvRow label="Cause" value={fire.cause ?? fire.general_cause} />
        <KvRow label="Fuel" value={fire.primary_fuel_group} />
        <KvRow label="County" value={fire.county} />
        <KvRow label="Behavior" value={fire.general_behavior} />
        <KvRow label="Complexity" value={fire.complexity_type} />
      </div>

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
