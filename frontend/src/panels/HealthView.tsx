/**
 * #/health — ingestion observability. Three sources, no backend:
 *  - GitHub Actions API (public repo, CORS-open): run conclusions, including
 *    runs that crashed before writing anything.
 *  - catalogs/health.json: the workers' own heartbeat (files, bytes, weather
 *    frames, skipped incidents) — a crashed run's absence shows as staleness.
 *  - The published catalogs' generated_at stamps: end-to-end data freshness.
 */
import { useQuery } from '@tanstack/react-query';
import { useHealth, useImsr, useMasterCatalog, useWeatherRuns } from '../api/queries';
import { formatBytes, formatRelative } from '../utils/format';

const REPO = 'pasha594/responder_debrief';

interface GhRun {
  name: string;
  conclusion: string | null;
  status: string;
  created_at: string;
  html_url: string;
  event: string;
}

async function fetchGhRuns(): Promise<GhRun[]> {
  const res = await fetch(
    `https://api.github.com/repos/${REPO}/actions/runs?per_page=40`,
    { headers: { Accept: 'application/vnd.github+json' } },
  );
  if (!res.ok) throw new Error(`github ${res.status}`);
  const body = (await res.json()) as { workflow_runs: GhRun[] };
  return body.workflow_runs;
}

const useGhRuns = () =>
  useQuery({ queryKey: ['gh-runs'], queryFn: fetchGhRuns, staleTime: 120_000, retry: 1 });

// ---------- freshness assessment ----------

type Grade = 'ok' | 'warn' | 'late' | 'unknown';

function grade(iso: string | null | undefined, okMs: number, warnMs: number): Grade {
  if (!iso) return 'unknown';
  const age = Date.now() - Date.parse(iso);
  if (!Number.isFinite(age)) return 'unknown';
  if (age <= okMs) return 'ok';
  if (age <= warnMs) return 'warn';
  return 'late';
}

function Dot({ grade: g }: { grade: Grade }) {
  return <span className={`rd-health-dot rd-health-dot--${g}`} aria-label={g} />;
}

function FreshnessRow({
  label,
  iso,
  okMs,
  warnMs,
  detail,
}: {
  label: string;
  iso: string | null | undefined;
  okMs: number;
  warnMs: number;
  detail?: string;
}) {
  return (
    <div className="rd-health-row">
      <Dot grade={grade(iso, okMs, warnMs)} />
      <span className="rd-health-row-label">{label}</span>
      <span className="rd-health-row-value">
        {iso ? formatRelative(iso) : 'never'}
        {detail ? ` · ${detail}` : ''}
      </span>
    </div>
  );
}

const HOUR = 3600_000;

function PipelineRuns({ runs, title }: { runs: GhRun[]; title: string }) {
  const recent = runs.slice(0, 10);
  const last = recent[0];
  return (
    <div className="rd-health-row">
      <Dot
        grade={
          !last ? 'unknown' : last.conclusion === 'success' || last.status === 'in_progress'
            ? 'ok'
            : 'late'
        }
      />
      <span className="rd-health-row-label">{title}</span>
      <span className="rd-health-runs">
        {recent
          .slice()
          .reverse()
          .map((r, i) => (
            <a
              key={i}
              href={r.html_url}
              target="_blank"
              rel="noopener noreferrer"
              className={`rd-health-runlet rd-health-runlet--${
                r.status === 'in_progress' || r.status === 'queued'
                  ? 'pending'
                  : r.conclusion === 'success'
                    ? 'ok'
                    : 'fail'
              }`}
              title={`${r.conclusion ?? r.status} · ${formatRelative(r.created_at)} (${r.event})`}
            />
          ))}
      </span>
      <span className="rd-health-row-value">
        {last ? `${last.conclusion ?? last.status} ${formatRelative(last.created_at)}` : '—'}
      </span>
    </div>
  );
}

export function HealthView() {
  const { data: gh, isError: ghErr } = useGhRuns();
  const { data: health } = useHealth();
  const { data: catalog } = useMasterCatalog();
  const { data: weather } = useWeatherRuns();
  const { data: imsr } = useImsr();

  const byWorkflow = (name: string) => (gh ?? []).filter((r) => r.name === name);
  const newestRendered = weather?.models.hrrr.runs.find(
    (r) => (r.frames?.hours?.length ?? 0) > 0,
  );

  const m = health?.mirror;
  const c = health?.catalogs;

  return (
    <div className="rd-health">
      <header className="rd-health-head">
        <a href="#/" className="rd-back">
          ← All fires
        </a>
        <h2>Ingestion health</h2>
        <a
          href={`https://github.com/${REPO}/actions`}
          target="_blank"
          rel="noopener noreferrer"
          className="rd-health-gh-link"
        >
          Actions ↗
        </a>
      </header>

      <section className="rd-section">
        <h3 className="rd-section-title">
          Pipelines
          <span className="rd-title-meta">last 10 runs, newest right</span>
        </h3>
        {ghErr && <div className="rd-empty">GitHub API unreachable (rate limit?) — see Actions ↗</div>}
        <PipelineRuns runs={byWorkflow('Sync catalogs')} title="Catalogs (hourly)" />
        <PipelineRuns runs={byWorkflow('Mirror incidents')} title="FTP mirror (4×/day)" />
        <PipelineRuns runs={byWorkflow('Deploy frontend (GitHub Pages)')} title="Site deploy" />
      </section>

      <section className="rd-section">
        <h3 className="rd-section-title">Data freshness</h3>
        <FreshnessRow
          label="Fire catalog"
          iso={catalog?.generated_at}
          okMs={1.5 * HOUR}
          warnMs={3 * HOUR}
          detail={catalog ? `v${catalog.version}, ${catalog.counts.active_fires} fires` : undefined}
        />
        <FreshnessRow
          label="Weather frames"
          iso={weather?.generated_at}
          okMs={2 * HOUR}
          warnMs={4 * HOUR}
          detail={
            newestRendered
              ? `${newestRendered.workspace} · ${newestRendered.frames?.hours?.length ?? 0}h rendered`
              : 'no drawable run'
          }
        />
        <FreshnessRow
          label="FTP mirror heartbeat"
          iso={m?.finished_at}
          okMs={7 * HOUR}
          warnMs={10 * HOUR}
        />
        <FreshnessRow
          label="Sit report (IMSR)"
          iso={imsr?.generated_at}
          okMs={26 * HOUR}
          warnMs={30 * HOUR}
          detail={imsr ? `${Object.keys(imsr.fires).length} fires matched` : undefined}
        />
      </section>

      <section className="rd-section">
        <h3 className="rd-section-title">
          Last mirror run
          <span className="rd-title-meta">{m ? formatRelative(m.finished_at) : 'no heartbeat yet'}</span>
        </h3>
        {m ? (
          <>
            <div className="rd-stats-strip">
              <div className="rd-stat">
                <span className="rd-stat-value">{m.candidates}</span>
                <span className="rd-stat-label">Dirs crawled</span>
              </div>
              <div className="rd-stat">
                <span className="rd-stat-value">{m.mirrored_incidents}</span>
                <span className="rd-stat-label">Mirrored</span>
              </div>
              <div className="rd-stat">
                <span className="rd-stat-value">{m.files_downloaded}</span>
                <span className="rd-stat-label">Files</span>
              </div>
              <div className="rd-stat">
                <span className="rd-stat-value">{formatBytes(m.bytes_downloaded)}</span>
                <span className="rd-stat-label">Fetched</span>
              </div>
            </div>
            <div className="rd-health-notes">
              {m.unchanged_skips} unchanged skipped
              {m.deadline_hit ? ' · stopped at time budget (resumes next run)' : ''}
              {!m.gdal_available ? ' · GDAL missing (tiling deferred)' : ''}
              {m.failed_incidents.length > 0 && (
                <> · FTP errors, retried next run: {m.failed_incidents.join(', ')}</>
              )}
            </div>
          </>
        ) : (
          <div className="rd-empty">Publishes after the next mirror run.</div>
        )}
      </section>

      <section className="rd-section">
        <h3 className="rd-section-title">
          Last catalogs run
          <span className="rd-title-meta">{c ? formatRelative(c.finished_at) : 'no heartbeat yet'}</span>
        </h3>
        {c ? (
          <>
            <div className="rd-stats-strip">
              <div className="rd-stat">
                <span className="rd-stat-value">{c.fires}</span>
                <span className="rd-stat-label">Fires</span>
              </div>
              <div className="rd-stat">
                <span className="rd-stat-value">{c.weather.images_fetched}</span>
                <span className="rd-stat-label">Wx frames</span>
              </div>
              <div className="rd-stat">
                <span className="rd-stat-value">{c.spread_fires}</span>
                <span className="rd-stat-label">Spread fires</span>
              </div>
              <div className="rd-stat">
                <span className="rd-stat-value">{c.imsr.matched_fires}</span>
                <span className="rd-stat-label">IMSR matched</span>
              </div>
            </div>
            <div className="rd-health-notes">
              {c.weather.runs.map((r) => `${r.workspace}: ${r.rendered}/${r.expected}h`).join(' · ')}
              {c.weather.carried_forward ? ' · carried previous run forward' : ''}
              {!c.weather.gdal_available ? ' · GDAL missing this run' : ''}
              {c.note ? ` · ${c.note}` : ''}
            </div>
          </>
        ) : (
          <div className="rd-empty">Publishes after the next catalogs run.</div>
        )}
      </section>
    </div>
  );
}
