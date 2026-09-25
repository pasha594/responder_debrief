/**
 * React hooks over the routing index / descriptors (TanStack Query, so the
 * Layers rows, Walk and the Offline card share one fetch). Offline, the
 * wrapped fetch serves both from the fire's pack; when the live index points
 * at a bundle the pack doesn't hold, the pack's own descriptor is used.
 */
import { useQuery } from '@tanstack/react-query';
import { useStore } from '../state/store';
import { packedRoutingDescriptor, packsReady } from '../offline/packs';
import { getBundle, getRoutingEntry } from './bundleIndex';
import type { RoutingBundle } from './types';

/** The bundle the fire's offline pack holds, or null. */
export async function loadPackedBundle(corneaId: string): Promise<RoutingBundle | null> {
  await packsReady;
  const packed = packedRoutingDescriptor(corneaId);
  if (!packed) return null;
  try {
    const res = await fetch(packed);
    return res.ok ? ((await res.json()) as RoutingBundle) : null;
  } catch {
    return null;
  }
}

/** Online: the live index's bundle (pack as fallback). Offline: the packed
 * bundle first — the live index may already point at a newer build whose
 * files this device never downloaded. */
export async function loadFireBundle(corneaId: string): Promise<RoutingBundle | null> {
  await packsReady;
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
  if (offline) {
    const p = await loadPackedBundle(corneaId);
    if (p) return p;
  }
  const st = await getRoutingEntry(corneaId);
  if (st.kind === 'ok') {
    const b = await getBundle(st.entry);
    if (b) return b;
  }
  return offline ? null : loadPackedBundle(corneaId);
}

export const useFireBundle = (corneaId: string | null) => {
  const online = useStore((s) => s.offline.online);
  return useQuery({
    queryKey: ['routing-bundle', corneaId, online],
    queryFn: () => loadFireBundle(corneaId!),
    enabled: !!corneaId,
    staleTime: 60_000,
    retry: 1,
  });
};
