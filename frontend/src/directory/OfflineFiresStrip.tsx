/**
 * One-line strip under the directory header listing fires downloaded for
 * offline use — the way into a fire when there is no service (the roster
 * itself needs the network... unless a pack's snapshot serves it).
 */
import { useStore } from '../state/store';
import { formatBytes } from '../offline/packs';

export function OfflineFiresStrip() {
  const packs = useStore((s) => s.offline.packs);
  const selectFire = useStore((s) => s.actions.selectFire);
  const entries = Object.values(packs).sort((a, b) =>
    b.downloadedAt.localeCompare(a.downloadedAt),
  );
  if (entries.length === 0) return null;
  return (
    <div className="rd-offline-strip">
      <span className="rd-offline-strip-label">Available offline:</span>
      {entries.map((p) => (
        <button
          key={p.slug}
          type="button"
          className="rd-chip rd-offline-chip"
          title={`${formatBytes(p.bytes)} · open the offline copy`}
          onClick={() => selectFire(p.corneaId)}
        >
          {p.name}
          {p.state ? ` · ${p.state}` : ''}
        </button>
      ))}
    </div>
  );
}
