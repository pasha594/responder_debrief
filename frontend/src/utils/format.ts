/**
 * Formatting helpers. Nulls always render as an em dash "—"; fire-local
 * times flow through formatDateTime with the fire's IANA timezone.
 */

const EMDASH = '—';

function trimTrailingZero(s: string): string {
  return s.replace(/\.0$/, '');
}

/** 1,234 ac / 12.3k ac / 1.2M ac. Null/invalid → "—". */
export function formatAcres(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n < 0) return EMDASH;
  let v: string;
  if (n >= 1_000_000) v = `${trimTrailingZero((n / 1_000_000).toFixed(1))}M`;
  else if (n >= 10_000) v = `${trimTrailingZero((n / 1_000).toFixed(1))}k`;
  else v = Math.round(n).toLocaleString('en-US');
  return `${v} ac`;
}

/** "71%" — rounded; null/invalid → "—". */
export function formatPct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return EMDASH;
  return `${Math.round(n)}%`;
}

/**
 * Relative time: "just now", "5 min ago", "2 h ago", "3 d ago";
 * future instants render "in 2 h". `nowMs` injectable for tests.
 */
export function formatRelative(
  input: string | number | Date,
  nowMs: number = Date.now(),
): string {
  const t = input instanceof Date ? input.getTime() : new Date(input).getTime();
  if (!Number.isFinite(t)) return EMDASH;
  const diff = nowMs - t;
  const abs = Math.abs(diff);
  if (abs < 45_000) return 'just now';
  let phrase: string;
  if (abs < 3_600_000) phrase = `${Math.max(1, Math.round(abs / 60_000))} min`;
  else if (abs < 48 * 3_600_000) phrase = `${Math.round(abs / 3_600_000)} h`;
  else phrase = `${Math.round(abs / 86_400_000)} d`;
  return diff >= 0 ? `${phrase} ago` : `in ${phrase}`;
}

/**
 * Absolute date-time via Intl with an optional IANA `timeZone` (fire-local)
 * and a short timezone name. Invalid tz falls back to the viewer's zone.
 */
export function formatDateTime(
  input: string | number | Date,
  tz?: string | null,
  opts: Intl.DateTimeFormatOptions = {},
): string {
  const d = input instanceof Date ? input : new Date(input);
  if (!Number.isFinite(d.getTime())) return EMDASH;
  const base: Intl.DateTimeFormatOptions = {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
    ...opts,
  };
  try {
    return new Intl.DateTimeFormat('en-US', { ...base, timeZone: tz ?? undefined }).format(d);
  } catch {
    return new Intl.DateTimeFormat('en-US', base).format(d);
  }
}

/** "890 B" / "340 KB" / "11 MB" / "1.2 GB". Null/invalid → "—". */
export function formatBytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n < 0) return EMDASH;
  if (n < 1024) return `${Math.round(n)} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb < 10 ? trimTrailingZero(mb.toFixed(1)) : Math.round(mb)} MB`;
  const gb = mb / 1024;
  return `${gb < 10 ? trimTrailingZero(gb.toFixed(1)) : Math.round(gb)} GB`;
}
