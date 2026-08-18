/**
 * Always-visible way out of the single-fire map: a floating pill at the map's
 * top-left (the sidebar owns the right edge, so the two never overlap). The
 * sidebar header keeps its own "← All fires" link for reading order.
 */
import { useStore } from '../state/store';

export function BackControl() {
  const backToDirectory = useStore((s) => s.actions.backToDirectory);
  return (
    <button
      type="button"
      className="rd-back-control"
      onClick={() => backToDirectory()}
      title="Back to all fires"
    >
      ← All fires
    </button>
  );
}
