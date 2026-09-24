/** Popover dismissal shared by the settings gear and the compact mobile menus. */
import { useEffect, type RefObject } from 'react';

/**
 * While `open`, a pointerdown outside `ref` or Escape calls `close`. The click
 * that dismissing pointerdown produces is swallowed: on the fire map it would
 * otherwise fall through to the canvas and drop a pin or a directions point.
 * Standard popover behavior — the dismissing click only dismisses.
 */
export function useDismiss(ref: RefObject<HTMLElement | null>, open: boolean, close: () => void): void {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current?.contains(e.target as Node)) return;
      close();
      const swallow = (ev: MouseEvent) => {
        ev.stopPropagation();
        ev.preventDefault();
      };
      document.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => document.removeEventListener('click', swallow, { capture: true }), 400);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [ref, open, close]);
}
