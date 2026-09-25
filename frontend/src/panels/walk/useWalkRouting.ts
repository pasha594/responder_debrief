/**
 * The Walk context for SearchDirectionsControl: this fire's routing bundle,
 * the LATEST perimeter (newest by date — not the timeline playhead), the
 * avoid flag and connectivity. `key` changes whenever any of those do, so
 * the control reruns ONLY the Walk profile (never Drive/Apparatus) when the
 * bundle or perimeter resolves.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { fetchPerimeterByPath } from '../../api/fireApi';
import { usePerimeterIndex } from '../../api/queries';
import type { PerimeterFeature, PerimeterIndexItem } from '../../api/types';
import type { WalkContext } from '../../api/walkRouting';
import { useFireBundle } from '../../routing/hooks';
import { useStore } from '../../state/store';

export function latestPerimeter(index: PerimeterIndexItem[] | undefined): PerimeterIndexItem | null {
  if (!index?.length) return null;
  const ts = (p: PerimeterIndexItem) => Date.parse(p.date) || 0;
  return index.reduce((a, b) => (ts(b) > ts(a) ? b : a));
}

export function useWalkContext() {
  const corneaId = useStore((s) => (s.view.mode === 'fire' ? s.view.corneaId : null));
  const online = useStore((s) => s.offline.online);
  const avoid = useStore((s) => s.directions.avoidPerimeter);
  const packed = useStore((s) => Object.values(s.offline.packs).some((p) => p.corneaId === corneaId));
  const qc = useQueryClient();
  const index = usePerimeterIndex(corneaId);
  const latest = latestPerimeter(index.data);
  const bundle = useFireBundle(corneaId);
  const [status, setStatus] = useState<string | null>(null);
  const key = `${corneaId}|${online}|${avoid}|${latest?.path ?? ''}|${bundle.data?.bundle_id ?? ''}`
    + `|${bundle.isFetched}`;

  const ctx = useCallback((): WalkContext => ({
    corneaId,
    online,
    avoidPerimeter: avoid,
    bundle: bundle.data ?? null,
    packed,
    nowMs: Date.now(),
    onStatus: setStatus,
    getPerimeter: async () => {
      if (!latest) return null;
      const feature = await qc.fetchQuery<PerimeterFeature>({
        queryKey: ['perimeter-version', latest.path],
        queryFn: () => fetchPerimeterByPath(latest.path),
        staleTime: Infinity,
      });
      return { feature, path: latest.path, date: latest.date };
    },
  }), [corneaId, online, avoid, bundle.data, packed, latest, qc]);

  return { key, ctx, status, bundle: bundle.data ?? null };
}
