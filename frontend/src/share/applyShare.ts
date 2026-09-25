/**
 * Apply a scanned share: open its fire (unless it is the one open), then hand
 * the store the whole view — see applySharedView and `share.pending` for the
 * parts that land as the map, timeline and draw layer come up.
 */
import { track } from '../app/analytics';
import { useStore } from '../state/store';
import type { ShareState } from './shareCodec';

export function applyShare(share: ShareState): void {
  const { view, actions } = useStore.getState();
  const sameFire = view.mode === 'fire' && view.corneaId === share.fire.corneaId;
  if (!sameFire) actions.selectFire(share.fire.corneaId);
  actions.applySharedView(share);
  track('share_applied', {
    same_fire: sameFire,
    drawings: share.drawings ? share.drawings.length : null,
  });
  actions.showToast(
    share.drawings
      ? 'Shared view applied — drawings replaced (Undo brings yours back)'
      : 'Shared view applied',
  );
}
