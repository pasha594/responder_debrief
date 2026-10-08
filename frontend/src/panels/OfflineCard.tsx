/**
 * "Download for offline" card on the fire Overview tab — the whole v1 UX in
 * one place: download with live progress + cancel, then downloaded state
 * with update/remove. Sizes are estimates until the download finishes.
 */
import { useState } from 'react';
import { useMasterCatalog } from '../api/queries';
import { sameFire } from '../api/fireKey';
import { useStore } from '../state/store';
import {
  cancelActiveDownload,
  downloadPack,
  formatBytes,
  opfsSupported,
  packForFire,
  removePack,
} from '../offline/packs';
import { formatRelative } from '../utils/format';
import { useFireBundle } from '../routing/hooks';

export function OfflineCard({ corneaId }: { corneaId: string }) {
  const { data: catalog } = useMasterCatalog();
  const packs = useStore((s) => s.offline.packs);
  const progress = useStore((s) => s.offline.progress);
  const online = useStore((s) => s.offline.online);
  const showToast = useStore((s) => s.actions.showToast);
  const [busy, setBusy] = useState(false);
  const bundle = useFireBundle(corneaId);

  if (!opfsSupported()) return null;
  const inCatalog = catalog?.fires.some((f) => sameFire(f.cornea_id, corneaId)) ?? false;
  const pack = packForFire(packs, corneaId);
  const mine = progress?.corneaId === corneaId ? progress : null;
  const otherDownloadActive = progress != null && progress.corneaId !== corneaId;

  const start = () => {
    setBusy(true);
    downloadPack(corneaId)
      .then((meta) => showToast(`Saved for offline — ${formatBytes(meta.bytes)}`))
      .catch((err: Error) => {
        if (err.message !== 'cancelled') {
          showToast('Offline download failed — check the connection and retry');
        }
      })
      .finally(() => setBusy(false));
  };

  const remove = () => {
    void removePack(corneaId).then(() => showToast('Offline copy removed'));
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
          <button type="button" className="rd-mini-btn" onClick={cancelActiveDownload}>
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
              disabled={!online || busy || otherDownloadActive || !inCatalog}
              title={
                !online
                  ? 'Reconnect to update'
                  : !inCatalog
                    ? catalog
                      ? 'Not in the catalog right now'
                      : 'Waiting for the catalog'
                    : 'Re-download with the newest data'
              }
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
          days of incident maps{bundle.data ? ', plus trails and offline walking routes' : ''}.
        </span>
        <button
          type="button"
          className="rd-offline-btn"
          disabled={!online || busy || otherDownloadActive || !inCatalog}
          title={
            !inCatalog
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
