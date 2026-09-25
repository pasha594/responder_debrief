/**
 * A scanned (or linked) share, before anything changes: what it holds, what
 * applying it will replace, and what this phone is missing to show it — the
 * code only points at the sheet and layers, which must come from THIS phone's
 * offline copy of the fire. Apply hands it to share/applyShare.
 */
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  useFires,
  useIncidentManifest,
  useMasterCatalog,
  useWeatherRuns,
} from '../api/queries';
import type { WeatherProduct } from '../api/types';
import { savedMarkCount } from '../map/layers/drawLayer';
import { sheetTileUrls } from '../offline/packModel';
import { applyShare } from '../share/applyShare';
import type { ShareState } from '../share/shareCodec';
import { useStore } from '../state/store';
import { formatDateTime, formatRelative } from '../utils/format';
import { seriesKey } from '../utils/incidentMaps';
import { lightboxTitle } from './MapLightbox';
import { SPREAD_PRODUCT_LABELS } from './tabs/ForecastTab';

const BASEMAP_LABELS: Record<ShareState['basemap'], string> = {
  map: 'Map',
  satellite: 'Satellite',
  topo: 'Topo',
};

/** Two offline copies saved further apart than this may differ. */
const COPY_SKEW_MS = 60 * 60_000;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function drawingsLine(share: ShareState, yours: number): string {
  const d = share.drawings;
  if (!d) return `Not included — your ${plural(yours, 'mark')} stay`;
  const lines = d.filter((f) => f.properties.kind === 'line').length;
  const marks = d.length - lines;
  const theirs = [marks && plural(marks, 'symbol'), lines && plural(lines, 'line')]
    .filter(Boolean)
    .join(', ') || 'none (clears yours)';
  return yours
    ? `${theirs} — replaces your ${plural(yours, 'mark')} (Undo brings them back)`
    : theirs;
}

function IncomingShareDialog({ share }: { share: ShareState }) {
  const { data: fires } = useFires();
  const { data: catalog } = useMasterCatalog();
  const { data: weatherRuns } = useWeatherRuns();
  const packs = useStore((s) => s.offline.packs);
  const online = useStore((s) => s.offline.online);
  const view = useStore((s) => s.view);
  const liveMarks = useStore((s) => s.draw.features.length);
  const actions = useStore((s) => s.actions);
  const applyRef = useRef<HTMLButtonElement>(null);

  const cid = share.fire.corneaId;
  const catalogFire = catalog?.fires.find((f) => f.cornea_id === cid) ?? null;
  const { data: manifest } = useIncidentManifest(catalogFire?.incident_manifest ?? null);
  const name =
    fires?.fires.find((f) => f.cornea_id === cid)?.post_title
    ?? catalogFire?.name
    ?? (share.fire.name || 'Unknown fire');
  const pack = Object.values(packs).find((p) => p.corneaId === cid) ?? null;
  const open = view.mode === 'fire' && view.corneaId === cid;
  const yours = open ? liveMarks : savedMarkCount(cid);
  const L = share.layers;

  const dismiss = () => actions.setIncomingShare(null);
  const apply = () => applyShare(share);

  useEffect(() => {
    applyRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        useStore.getState().actions.setIncomingShare(null);
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, []);

  // --- the sheet, resolved against this phone's copy ---
  const maps = manifest?.maps ?? [];
  const sheet = L.incidentMap.series
    ? maps.find((m) => seriesKey(m) === L.incidentMap.series) ?? null
    : L.incidentMap.mapId
      ? maps.find((m) => m.id === L.incidentMap.mapId) ?? null
      : null;
  const wantsSheet = !!(L.incidentMap.mapId || L.incidentMap.series);
  const sheetLabel = !wantsSheet
    ? 'None'
    : sheet
      ? L.incidentMap.series
        ? `${sheet.product_label} (every version, on the timeline)`
        : lightboxTitle(sheet)
      : 'A sheet this phone doesn’t have';
  const sheetOffline = !!(sheet?.tiles && pack && pack.files[sheetTileUrls(sheet.tiles)[0]]);

  // --- layers ---
  const weatherLabel = (p: WeatherProduct) => {
    for (const m of Object.values(weatherRuns?.models ?? {})) {
      const label = m.products?.[p]?.label;
      if (label) return label;
    }
    return p.toUpperCase();
  };
  const weather = (Object.keys(L.weather) as WeatherProduct[]).map(weatherLabel);
  const forecast = L.spread.visible
    ? `${SPREAD_PRODUCT_LABELS[L.spread.product]} (P${L.spread.percentile})`
    : null;
  const ir = L.irFlight
    ? manifest?.ir_flights.find((f) => f.flight_id === L.irFlight)?.flight_date ?? L.irFlight
    : null;
  const layers = [forecast, ...weather, ir && `IR heat ${ir}`].filter(Boolean).join(' · ') || 'None';

  // --- what this phone is missing ---
  const warnings: string[] = [];
  if (!pack) {
    warnings.push(online
      ? 'This fire isn’t saved for offline on this phone — its layers load from the network.'
      : 'This fire isn’t saved on this phone, so its layers and sheet can’t load until you have signal.');
  }
  if (wantsSheet && manifest && !sheet) {
    warnings.push('The incident sheet isn’t in your copy of this fire — the rest still applies.');
  } else if (sheet && pack && !sheetOffline && !online) {
    warnings.push('That sheet wasn’t saved with your offline copy, so it can’t show until you have signal.');
  }
  if (pack && share.packSavedAt != null) {
    const mine = Date.parse(pack.downloadedAt);
    if (Number.isFinite(mine) && Math.abs(mine - share.packSavedAt) > COPY_SKEW_MS) {
      warnings.push(
        `Your copy was saved ${formatRelative(mine)}, theirs ${formatRelative(share.packSavedAt)} — `
        + 'forecasts and sheets may differ.',
      );
    }
  }

  const rows: [string, string][] = [
    ['Fire', name],
    ['Map view', `${BASEMAP_LABELS[share.basemap]} basemap, their position and zoom`],
    ['Timeline', share.time == null ? 'Now' : formatDateTime(share.time, catalogFire?.timezone)],
    ['Incident sheet', sheetLabel],
    ['Forecast & weather', layers],
    ['Drawings', drawingsLine(share, yours)],
  ];

  return createPortal(
    <div
      className="rd-lightbox rd-qr-backdrop"
      onMouseDown={(e) => {
        if (e.target !== e.currentTarget) return;
        e.preventDefault();
        dismiss();
      }}
    >
      <div
        className="rd-lightbox-dialog rd-qr-dialog rd-share-card"
        role="dialog"
        aria-modal="true"
        aria-label="Shared view"
      >
        <div className="rd-lightbox-bar">
          <span className="rd-lightbox-title">Shared view</span>
          <span className="rd-share-when">shared {formatRelative(share.sharedAt)}</span>
        </div>
        <dl className="rd-share-rows">
          {rows.map(([k, v]) => (
            <div key={k} className="rd-share-row">
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
        {warnings.length > 0 && (
          <ul className="rd-share-warnings">
            {warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        )}
        <div className="rd-share-actions">
          <button type="button" className="rd-mini-btn" onClick={dismiss}>
            Cancel
          </button>
          <button type="button" className="rd-offline-btn" ref={applyRef} onClick={apply}>
            Apply
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Mounted once at the app root; renders while a share awaits a decision. */
export function IncomingShareCard() {
  const share = useStore((s) => s.share.incoming);
  return share ? <IncomingShareDialog share={share} /> : null;
}
