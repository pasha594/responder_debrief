/**
 * Hotspot `confidence` mixes vocabularies: numeric strings for MODIS
 * ("69"), letter codes for VIIRS sources ("l" | "n" | "h"). Normalize once at
 * ingest; styling/filtering use conf_norm only, popups show the raw value.
 */
export type ConfidenceNorm = 'low' | 'nominal' | 'high';

export function normalizeConfidence(confidence: string | null | undefined): ConfidenceNorm {
  if (!confidence) return 'nominal';
  const c = confidence.trim().toLowerCase();
  if (c === 'l' || c === 'low') return 'low';
  if (c === 'n' || c === 'nominal') return 'nominal';
  if (c === 'h' || c === 'high') return 'high';
  const n = Number(c);
  if (Number.isFinite(n)) {
    if (n < 30) return 'low';
    if (n < 80) return 'nominal';
    return 'high';
  }
  return 'nominal';
}
