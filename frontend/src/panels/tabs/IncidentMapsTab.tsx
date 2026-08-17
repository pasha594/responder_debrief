/** Incident maps: grouped GeoPDF products, tiled overlays, IR flights. */
import { useMemo } from 'react';
import { useIncidentManifest, useMasterCatalog } from '../../api/queries';
import { dataUrl } from '../../api/catalogs';
import type { IncidentMapEntry, IrFlight } from '../../api/types';
import { useMap } from '../../map/MapRoot';
import { useStore } from '../../state/store';
import { formatBytes } from '../../utils/format';

const GROUP_ORDER = ['ops', 'iap', 'brief', 'airops', 'evac', 'trans', 'pio', 'other', 'qr', 'mobile'];

function groupKey(m: IncidentMapEntry): string {
  if (m.kind === 'qr') return 'qr';
  if (m.kind === 'mobile') return 'mobile';
  return m.product;
}

function groupRank(key: string): number {
  const i = GROUP_ORDER.indexOf(key);
  return i >= 0 ? i : GROUP_ORDER.indexOf('other') + 0.5;
}

function entryTitle(m: IncidentMapEntry): string {
  let t = m.product_label;
  if (m.op_date) t += ` — ${m.op_date}`;
  if (m.period) t += ` (${m.period})`;
  return t;
}

/** Shared resolution: catalog fire → incident manifest. */
function useManifestForFire(corneaId: string | null) {
  const { data: catalog } = useMasterCatalog();
  const catalogFire = useMemo(
    () => catalog?.fires.find((f) => f.cornea_id === corneaId) ?? null,
    [catalog, corneaId],
  );
  return useIncidentManifest(catalogFire?.incident_manifest ?? null);
}

function Thumb({ entry }: { entry: IncidentMapEntry }) {
  if (!entry.preview_url) {
    return (
      <div className="rd-thumb rd-thumb--fallback" aria-hidden="true">
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
          <rect x="2.5" y="2.5" width="15" height="15" rx="2" stroke="currentColor" />
          <path d="M2.5 13l4-4 4 4 3-3 4 4" stroke="currentColor" fill="none" />
        </svg>
      </div>
    );
  }
  return (
    <img
      className="rd-thumb"
      src={dataUrl(entry.preview_url)}
      alt=""
      loading="lazy"
      width={56}
      height={56}
    />
  );
}

function MapRow({ entry }: { entry: IncidentMapEntry }) {
  const map = useMap();
  const incident = useStore((s) => s.layers.incidentMap);
  const actions = useStore((s) => s.actions);
  const active = incident.mapId === entry.id;
  const pdfHref = dataUrl(entry.pdf_url) + '?v=' + entry.rev;

  if (entry.kind === 'mobile') {
    return (
      <a
        className="rd-map-row rd-map-row--download"
        href={pdfHref}
        target="_blank"
        rel="noopener noreferrer"
      >
        <Thumb entry={entry} />
        <div className="rd-map-row-body">
          <div className="rd-map-row-title">{entryTitle(entry)}</div>
          <div className="rd-map-row-meta">
            Avenza mobile map — {formatBytes(entry.size_bytes)}
          </div>
        </div>
      </a>
    );
  }

  return (
    <div className={`rd-map-row${active ? ' rd-map-row--active' : ''}`}>
      <Thumb entry={entry} />
      <div className="rd-map-row-body">
        <div className="rd-map-row-title">{entryTitle(entry)}</div>
        <div className="rd-map-row-meta">{formatBytes(entry.size_bytes)}</div>

        {entry.tiles ? (
          <div className="rd-map-row-actions">
            <button
              type="button"
              className={`rd-toggle-btn${active ? ' rd-toggle-btn--on' : ''}`}
              aria-pressed={active}
              onClick={() => actions.setIncidentMap(active ? null : entry.id)}
            >
              <span className="rd-radio-dot" aria-hidden="true" />
              {active ? 'Shown on map' : 'Show on map'}
            </button>
            {active && (
              <>
                <input
                  type="range"
                  className="rd-slider"
                  min={0}
                  max={1}
                  step={0.05}
                  value={incident.opacity}
                  onChange={(e) => actions.setIncidentMapOpacity(Number(e.target.value))}
                  aria-label="Overlay opacity"
                />
                <button
                  type="button"
                  className="rd-mini-btn"
                  onClick={() => {
                    const b = entry.tiles!.bounds;
                    map?.fitBounds(
                      [
                        [b[0], b[1]],
                        [b[2], b[3]],
                      ],
                      { padding: 48, duration: 800 },
                    );
                  }}
                >
                  Zoom to
                </button>
              </>
            )}
          </div>
        ) : entry.tiling_pending ? (
          <div className="rd-processing">processing…</div>
        ) : (
          <div className="rd-map-row-actions">
            <a
              className="rd-pdf-pill"
              href={pdfHref}
              target="_blank"
              rel="noopener noreferrer"
            >
              PDF ↗
            </a>
          </div>
        )}
      </div>
    </div>
  );
}

function IrFlightRow({ flight }: { flight: IrFlight }) {
  const activeId = useStore((s) => s.layers.irFlight.flightId);
  const actions = useStore((s) => s.actions);
  const active = activeId === flight.flight_id;
  const canShow = !!flight.geojson_url;
  return (
    <div className={`rd-ir-row${active ? ' rd-ir-row--active' : ''}`}>
      <div className="rd-ir-row-main">
        <span className="rd-ir-date">{flight.flight_date}</span>
        <span className="rd-ir-acres">
          {flight.estimated_acres != null
            ? `${Math.round(flight.estimated_acres).toLocaleString('en-US')} ac est.`
            : flight.no_flight_reason ?? '—'}
        </span>
      </div>
      <div className="rd-ir-row-actions">
        <button
          type="button"
          className={`rd-toggle-btn${active ? ' rd-toggle-btn--on' : ''}`}
          aria-pressed={active}
          disabled={!canShow}
          title={canShow ? undefined : 'No heat perimeter for this flight'}
          onClick={() => actions.setIrFlight(active ? null : flight.flight_id)}
        >
          <span className="rd-radio-dot" aria-hidden="true" />
          {active ? 'Shown' : 'Show heat'}
        </button>
        {flight.pdf_url && (
          <a
            className="rd-pdf-pill"
            href={dataUrl(flight.pdf_url)}
            target="_blank"
            rel="noopener noreferrer"
          >
            PDF
          </a>
        )}
        {flight.kmz_url && (
          <a
            className="rd-pdf-pill"
            href={dataUrl(flight.kmz_url)}
            target="_blank"
            rel="noopener noreferrer"
          >
            KMZ
          </a>
        )}
      </div>
    </div>
  );
}

export function IncidentMapsTab({ corneaId }: { corneaId: string }) {
  const { data: manifest, isLoading } = useManifestForFire(corneaId);

  const groups = useMemo(() => {
    if (!manifest) return [];
    const byKey = new Map<string, IncidentMapEntry[]>();
    for (const m of manifest.maps) {
      const key = groupKey(m);
      const list = byKey.get(key);
      if (list) list.push(m);
      else byKey.set(key, [m]);
    }
    return [...byKey.entries()].sort((a, b) => groupRank(a[0]) - groupRank(b[0]));
  }, [manifest]);

  if (isLoading) return <div className="rd-empty">Loading incident maps…</div>;
  if (!manifest || (manifest.maps.length === 0 && manifest.ir_flights.length === 0)) {
    return <div className="rd-empty">No incident maps published for this fire.</div>;
  }

  return (
    <div className="rd-tab-body">
      {groups.map(([key, entries]) => (
        <section key={key} className="rd-map-group">
          <h3 className="rd-section-title">{entries[0].product_label}</h3>
          {entries.map((m) => (
            <MapRow key={m.id} entry={m} />
          ))}
        </section>
      ))}

      {manifest.ir_flights.length > 0 && (
        <section className="rd-map-group">
          <h3 className="rd-section-title">IR flights</h3>
          {manifest.ir_flights.map((f) => (
            <IrFlightRow key={f.flight_id} flight={f} />
          ))}
        </section>
      )}
    </div>
  );
}

/**
 * Floating dismiss chip for the active incident-map overlay. Rendered by the
 * Sidebar (position: fixed over the map, bottom-left above the legend).
 */
export function IncidentMapChip() {
  const mapId = useStore((s) => s.layers.incidentMap.mapId);
  const view = useStore((s) => s.view);
  const actions = useStore((s) => s.actions);
  const corneaId = view.mode === 'fire' ? view.corneaId : null;
  const { data: manifest } = useManifestForFire(corneaId);

  if (!mapId) return null;
  const entry = manifest?.maps.find((m) => m.id === mapId);
  const title = entry ? entryTitle(entry) : 'Incident map';

  return (
    <div className="rd-map-chip">
      <span className="rd-map-chip-title">{title}</span>
      <button
        type="button"
        className="rd-map-chip-x"
        aria-label="Remove incident map overlay"
        onClick={() => actions.setIncidentMap(null)}
      >
        ✕
      </button>
    </div>
  );
}
