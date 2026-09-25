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
 * Drawing tools folded behind one "Drawing Tools" button: phones, touch-first
 * devices like iPads at any width, and windows under 870px. Mouse-driven
 * desktops show them open.
 */
export const useFoldedDrawTools = () => useMediaQuery('(max-width: 869px), (pointer: coarse)');
