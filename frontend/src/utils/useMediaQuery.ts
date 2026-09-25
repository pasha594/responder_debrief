/** Reactive matchMedia hook (shared by the sidebar shell and the directory). */
import { useEffect, useState } from 'react';

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = () => setMatches(mq.matches);
    setMatches(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

/** The app's one breakpoint: ≥768px gets the desktop layouts. */
export const useIsDesktop = () => useMediaQuery('(min-width: 768px)');

/**
 * Folded map controls (back arrow, basemap pill, compact search, Drawing
 * Tools menu): phones, touch-first devices like iPads at any width, and
 * windows under 870px, too narrow for the full controls. Tablets and narrow
 * windows keep the side panel; only the controls fold.
 */
export const useCompactControls = () => useMediaQuery('(max-width: 869px), (pointer: coarse)');
