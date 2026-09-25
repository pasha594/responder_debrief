/** Messages between offroadClient (main thread) and offroad.worker. */
import type { OffroadErrorCode, OffroadResult } from './engine';
import type { RoutingBundle } from './types';

export type ToWorker =
  | { t: 'load'; id: number; bundle: RoutingBundle; grid: ArrayBuffer; dem: ArrayBuffer; graph: ArrayBuffer }
  | { t: 'perimeter'; id: number; key: string | null; polygons: [number, number][][][] | null }
  | { t: 'route'; id: number; a: [number, number]; b: [number, number]; avoidPerimeter: boolean;
      perimeterDate: string | null }
  | { t: 'veg'; id: number; maxWidth: number; alpha: number };

export type FromWorker =
  | { t: 'loaded'; id: number; bundleId: string; ms: number; cells: number; nodes: number }
  | { t: 'perimeterSet'; id: number; key: string | null; masked: number }
  | { t: 'progress'; id: number; settled: number }
  | { t: 'route'; id: number; result: OffroadResult }
  | { t: 'veg'; id: number; width: number; height: number; rgba: ArrayBuffer }
  | { t: 'error'; id: number; code: OffroadErrorCode | 'not-loaded'; message: string };
