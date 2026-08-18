/**
 * Incident maps: the FTP map wall for one fire, grouped the way an incident
 * runs — by operational date, newest first, then by product priority inside
 * the day. Each row's affordance follows the sheet's georeferencing:
 * overlayable sheets drape on the map, flat sheets open a lightbox.
 */
import { useMemo, useState } from 'react';
import { useFire, useIncidentManifest, useMasterCatalog } from '../../api/queries';
import { dataUrl } from '../../api/catalogs';
import type { IncidentMapEntry, IrFlight } from '../../api/types';
import { useMap } from '../../map/MapRoot';
import { useStore } from '../../state/store';
import { formatBytes, formatTime } from '../../utils/format';
import {
  friendlyOpDate,
  groupMapsByDate,
  localToday,
  rowAction,
} from '../../utils/incidentMaps';
import { MapLightbox } from '../MapLightbox';

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

/**
 * The row's own sub-label: when the sheet was uploaded + size. Upload time is
 * the FTP Last-Modified (UTC ISO, shown fire-local); older manifests without
 * it fall back to the filename's generation stamp (already fire-local wall
 * time — parsed as-is, NOT through a zone), then to the day/night period.
 */
function rowMeta(entry: IncidentMapEntry, timezone: string | null): string {
  const parts: string[] = [];
  if (entry.uploaded_at) {
    const t = Date.parse(entry.uploaded_at);
    if (Number.isFinite(t)) parts.push(`Uploaded ${formatTime(t, timezone)}`);
  } else if (entry.generated_at_local) {
    const m = /T(\d{2}):(\d{2})/.exec(entry.generated_at_local);
    if (m) parts.push(`Generated ${m[1]}:${m[2]}`);
  }
  if (!parts.length && entry.period) parts.push(entry.period === 'night' ? 'Night' : 'Day');
  if (entry.kind === 'qr') parts.push('QR sheet');
  parts.push(formatBytes(entry.size_bytes));
  return parts.join(' · ');
}

function MapRow({
  entry,
  timezone,
  onView,
}: {
  entry: IncidentMapEntry;
  timezone: string | null;
  onView: () => void;
}) {
  const map = useMap();
  const incident = useStore((s) => s.layers.incidentMap);
  const actions = useStore((s) => s.actions);
  const active = incident.mapId === entry.id;
  const pdfHref = dataUrl(entry.pdf_url) + '?v=' + entry.rev;
  const action = rowAction(entry);

  if (action === 'download') {
    return (
      <a
        className="rd-map-row rd-map-row--download"
        href={pdfHref}
        target="_blank"
        rel="noopener noreferrer"
      >
        <Thumb entry={entry} />
        <div className="rd-map-row-body">
          <div className="rd-map-row-title">{entry.product_label}</div>
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
        <div className="rd-map-row-title">{entry.product_label}</div>
        <div className="rd-map-row-meta">{rowMeta(entry, timezone)}</div>

        <div className="rd-map-row-actions">
          {action === 'overlay' && (
            <button
              type="button"
              className={`rd-toggle-btn${active ? ' rd-toggle-btn--on' : ''}`}
              aria-pressed={active}
              onClick={() => actions.setIncidentMap(active ? null : entry.id)}
            >
              <span className="rd-radio-dot" aria-hidden="true" />
              {active ? 'Shown on map' : 'Show on map'}
            </button>
          )}

          {action === 'overlay-soon' && (
            <button
              type="button"
              className="rd-toggle-btn"
              disabled
              aria-pressed={false}
              title="The map overlay for this sheet is still rendering"
            >
              <span className="rd-radio-dot" aria-hidden="true" />
              Show on map
            </button>
          )}

          {action === 'view' && (
            <button type="button" className="rd-mini-btn" onClick={onView}>
              View
            </button>
          )}

          {/* The PDF is always reachable — it is the sheet of record, whether
              or not the row can drape it on the map. */}
          <a className="rd-pdf-pill" href={pdfHref} target="_blank" rel="noopener noreferrer">
            PDF ↗
          </a>

          {action === 'overlay' && active && (
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

        {action === 'overlay-soon' && (
          <div className="rd-pending-note">overlay rendering — check back shortly</div>
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
  const { data: fire } = useFire(corneaId);
  const [viewing, setViewing] = useState<string | null>(null);

  const groups = useMemo(() => groupMapsByDate(manifest?.maps ?? []), [manifest]);
  // "Today" is the fire's today, not the viewer's.
  const today = useMemo(() => localToday(fire?.timezone ?? null), [fire]);
  const viewingEntry = viewing
    ? manifest?.maps.find((m) => m.id === viewing) ?? null
    : null;

  if (isLoading) return <div className="rd-empty">Loading incident maps…</div>;
  if (!manifest || (manifest.maps.length === 0 && manifest.ir_flights.length === 0)) {
    return <div className="rd-empty">No incident maps published for this fire.</div>;
  }

  return (
    <div className="rd-tab-body">
      {groups.map((group) => {
        const heading = friendlyOpDate(group.date, today);
        return (
          <section key={group.date ?? 'undated'} className="rd-map-group">
            <h3 className="rd-section-title rd-map-date-head">
              <span>{heading.primary}</span>
              {heading.secondary && heading.secondary !== heading.primary && (
                <span className="rd-map-date-sub">{heading.secondary}</span>
              )}
            </h3>
            {group.entries.map((m) => (
              <MapRow
                key={m.id}
                entry={m}
                timezone={fire?.timezone ?? null}
                onView={() => setViewing(m.id)}
              />
            ))}
          </section>
        );
      })}

      {manifest.ir_flights.length > 0 && (
        <section className="rd-map-group">
          <h3 className="rd-section-title">IR flights</h3>
          {manifest.ir_flights.map((f) => (
            <IrFlightRow key={f.flight_id} flight={f} />
          ))}
        </section>
      )}

      {viewingEntry && (
        <MapLightbox entry={viewingEntry} onClose={() => setViewing(null)} />
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
