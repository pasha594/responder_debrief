/**
 * Always-visible way out of the single-fire map: a floating pill at the map's
 * top-left (the sidebar owns the right edge, so the two never overlap). The
 * sidebar header keeps its own "← All fires" link for reading order.
 *
 * On phones, touch tablets and narrow windows it shrinks to an arrow: the
 * first tap spells out "← All fires" (so a stray tap can't drop you out of
 * the fire), a second tap goes back, and it folds away again after 2 seconds.
 */
import { useEffect, useState } from 'react';
import { useStore } from '../state/store';
import { useCompactControls } from '../utils/useMediaQuery';

export function BackControl() {
  const backToDirectory = useStore((s) => s.actions.backToDirectory);
  const fullControls = !useCompactControls();
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (!expanded) return;
    const t = setTimeout(() => setExpanded(false), 2000);
    return () => clearTimeout(t);
  }, [expanded]);

  const compact = !fullControls && !expanded;
  const button = (
    <button
      type="button"
      className={`rd-back-control${compact ? ' rd-back-control--compact' : ''}`}
      data-testid="rd-fire-shell"
      onClick={() => (compact ? setExpanded(true) : backToDirectory())}
      title="Back to all fires"
      aria-label={compact ? 'Back to all fires' : undefined}
    >
      {compact ? '←' : '← All fires'}
    </button>
  );
  // folded: the arrow keeps a fixed slot, so spelling it out overlaps the
  // basemap pill instead of shoving the one-line toolbar along
  return fullControls ? button : <span className="rd-back-slot">{button}</span>;
}
