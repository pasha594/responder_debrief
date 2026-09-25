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
 * Tools menu): phones, and touch-first devices like iPads at any width —
 * a tablet keeps the side panel but gets the phone's controls. Mouse-driven
 * desktops keep the full ones however narrow the window.
 */
export const useCompactControls = () => useMediaQuery('(max-width: 767px), (pointer: coarse)');
