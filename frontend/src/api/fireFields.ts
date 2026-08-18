/** Shared predicates over raw fire-API fields (no formatting, no fetching). */

/**
 * The live index reports prescribed burns as "Prescribed"; older payloads and
 * docs say "Prescribed Fire". Match on the prefix so both spellings count.
 */
export function isPrescribed(firetype: string | null | undefined): boolean {
  return typeof firetype === 'string' && /^prescribed/i.test(firetype.trim());
}
