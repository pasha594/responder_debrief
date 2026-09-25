/**
 * React hooks over the routing index / descriptors (TanStack Query, so the
 * Layers rows, Walk and the Offline card share one fetch). Offline, the
 * wrapped fetch serves both from the fire's pack; when the live index points
 * at a bundle the pack doesn't hold, the pack's own descriptor is used.
 */
import { useQuery } from '@tanstack/react-query';
import { packedRoutingDescriptor, packsReady } from '../offline/packs';
import { getBundle, getRoutingEntry } from './bundleIndex';
import type { RoutingBundle } from './types';

export async function loadFireBundle(corneaId: string): Promise<RoutingBundle | null> {
  await packsReady;
  const st = await getRoutingEntry(corneaId);
  if (st.kind === 'ok') {
    const b = await getBundle(st.entry);
    if (b) return b;
  }
  const packed = packedRoutingDescriptor(corneaId);
  if (!packed) return null;
  try {
    const res = await fetch(packed);
    return res.ok ? ((await res.json()) as RoutingBundle) : null;
  } catch {
    return null;
  }
}

export const useFireBundle = (corneaId: string | null) =>
  useQuery({
    queryKey: ['routing-bundle', corneaId],
    queryFn: () => loadFireBundle(corneaId!),
    enabled: !!corneaId,
    staleTime: 60_000,
    retry: 1,
  });
