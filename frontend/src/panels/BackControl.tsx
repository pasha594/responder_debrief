/**
 * Always-visible way out of the single-fire map: an arrow at the start of the
 * map's top line (the sidebar owns the right edge, so the two never overlap).
 * The sidebar header keeps its own "← All fires" link for reading order.
 *
 * The first tap spells out "← All fires" in place, nudging the rest of the
 * line along (so a stray tap can't drop you out of the fire); a second tap
 * goes back, and it folds away again after 2 seconds.
 */
import { useEffect, useState } from 'react';
import { useStore } from '../state/store';

export function BackControl() {
  const backToDirectory = useStore((s) => s.actions.backToDirectory);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (!expanded) return;
    const t = setTimeout(() => setExpanded(false), 2000);
    return () => clearTimeout(t);
  }, [expanded]);

  return (
    <button
      type="button"
      className={`rd-back-control${expanded ? '' : ' rd-back-control--compact'}`}
      data-testid="rd-fire-shell"
      onClick={() => (expanded ? backToDirectory() : setExpanded(true))}
      title="Back to all fires"
      aria-label={expanded ? undefined : 'Back to all fires'}
    >
      {expanded ? '← All fires' : '←'}
    </button>
  );
}
