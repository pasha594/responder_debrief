/**
 * "Download for offline" card on the fire Overview tab — the whole v1 UX in
 * one place: download with live progress + cancel, then downloaded state
 * with update/remove. Sizes are estimates until the download finishes.
 */
import { useRef, useState } from 'react';
import { useMasterCatalog } from '../api/queries';
import { useStore } from '../state/store';
import {
  downloadPack,
  formatBytes,
  opfsSupported,
  removePack,
} from '../offline/packs';
import { formatRelative } from '../utils/format';

export function OfflineCard({ corneaId }: { corneaId: string }) {
  const { data: catalog } = useMasterCatalog();
  const packs = useStore((s) => s.offline.packs);
  const progress = useStore((s) => s.offline.progress);
  const online = useStore((s) => s.offline.online);
  const showToast = useStore((s) => s.actions.showToast);
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  if (!opfsSupported()) return null;
  const slug = catalog?.fires.find((f) => f.cornea_id === corneaId)?.fire_slug ?? null;
  const pack = slug ? packs[slug] : null;
  const mine = progress?.corneaId === corneaId ? progress : null;
  const otherDownloadActive = progress != null && progress.corneaId !== corneaId;

  const start = () => {
    const ctl = new AbortController();
    abortRef.current = ctl;
    setBusy(true);
    downloadPack(corneaId, ctl.signal)
      .then((meta) => showToast(`Saved for offline — ${formatBytes(meta.bytes)}`))
      .catch((err: Error) => {
        if (err.message !== 'cancelled') {
          showToast('Offline download failed — check the connection and retry');
        }
      })
      .finally(() => setBusy(false));
  };

  const remove = () => {
    if (!slug) return;
    void removePack(slug).then(() => showToast('Offline copy removed'));
  };

  if (mine) {
    const pct = mine.total > 0 ? Math.round((mine.done / mine.total) * 100) : 0;
    return (
      <div className="rd-offline-card">
        <div className="rd-offline-row">
          <span>
            Downloading… {pct}% ({mine.done.toLocaleString()} of{' '}
            {mine.total.toLocaleString()} files
            {mine.bytes > 0 ? ` · ${formatBytes(mine.bytes)}` : ''})
          </span>
          <button
            type="button"
            className="rd-mini-btn"
            onClick={() => abortRef.current?.abort()}
          >
            Cancel
          </button>
        </div>
        <div className="rd-offline-bar">
          <div className="rd-offline-bar-fill" style={{ width: `${pct}%` }} />
        </div>
        <div className="rd-offline-note">Keep this page open until the download finishes.</div>
      </div>
    );
  }

  if (pack) {
    return (
      <div className="rd-offline-card">
        <div className="rd-offline-row">
          <span>
            <span className="rd-offline-ok">✓</span> Available offline ·{' '}
            {formatBytes(pack.bytes)} · saved {formatRelative(pack.downloadedAt, Date.now())}
          </span>
          <span className="rd-offline-actions">
            <button
              type="button"
              className="rd-mini-btn"
              disabled={!online || busy || otherDownloadActive}
              title={online ? 'Re-download with the newest data' : 'Reconnect to update'}
              onClick={start}
            >
              Update
            </button>
            <button type="button" className="rd-mini-btn" onClick={remove}>
              Remove
            </button>
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="rd-offline-card">
      <div className="rd-offline-row">
        <span>
          Take this fire offline: perimeters, hotspots, forecast, weather, and the last 2
          days of incident maps.
        </span>
        <button
          type="button"
          className="rd-offline-btn"
          disabled={!online || busy || otherDownloadActive || !slug}
          title={
            !slug
              ? 'Waiting for the catalog'
              : otherDownloadActive
                ? 'Another download is running'
                : undefined
          }
          onClick={start}
        >
          Download
        </button>
      </div>
    </div>
  );
}
