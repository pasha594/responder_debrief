/**
 * Our own symbol layers (draw labels) request glyphs from whatever font
 * server the ACTIVE basemap style declares. OpenFreeMap hosts "Noto Sans
 * Bold"; CARTO's server does not (404) but both host "Noto Sans Regular" —
 * so the label font follows the active glyph host, and a style swap
 * re-normalizes the layers that already exist.
 */
import type { Map as MlMap } from 'maplibre-gl';

/** Bold where the glyph server has it, regular elsewhere. */
export function rdLabelFont(map: MlMap): string[] {
  const glyphs = map.getStyle()?.glyphs ?? '';
  return glyphs.includes('openfreemap') ? ['Noto Sans Bold'] : ['Noto Sans Regular'];
}

/** Re-point every rd- symbol layer's Noto stack at the active glyph host. */
export function resyncRdLabelFonts(map: MlMap): void {
  const font = rdLabelFont(map);
  for (const l of map.getStyle()?.layers ?? []) {
    if (l.type !== 'symbol' || !l.id.startsWith('rd-')) continue;
    const stack = (l.layout as { 'text-font'?: unknown } | undefined)?.['text-font'];
    if (!Array.isArray(stack) || typeof stack[0] !== 'string') continue;
    if (stack[0].startsWith('Noto Sans') && stack[0] !== font[0]) {
      try {
        map.setLayoutProperty(l.id, 'text-font', font);
      } catch {
        /* layer vanished mid-iteration */
      }
    }
  }
}
