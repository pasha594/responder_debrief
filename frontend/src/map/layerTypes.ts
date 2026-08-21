/**
 * Contract between the map shell and the imperative layer managers.
 * Each manager owns its rd- sources/layers; `update` must be cheap and
 * idempotent — it runs on every relevant store/data change.
 */
import type { Map as MlMap } from 'maplibre-gl';
import type {
  FireDetail,
  FiresListResponse,
  HotspotFeatureCollection,
  IncidentManifest,
  MasterCatalog,
  PerimeterFeature,
  PerimeterIndexItem,
  PyrecastRun,
  WeatherRun,
} from '../api/types';
import type { AppState } from '../state/store';

/** Everything a layer manager may need, assembled by useMapLayerSync. */
export interface LayerContext {
  view: AppState['view'];
  layers: AppState['layers'];
  currentTime: number;
  now: number;

  fires: FiresListResponse | undefined;
  selectedFire: FireDetail | undefined;
  selectedFireSlug: string | null;
  perimeterIndex: PerimeterIndexItem[] | undefined;
  /** Version resolved for currentTime, already fetched (or undefined while loading). */
  perimeterFeature: PerimeterFeature | undefined;
  hotspots: HotspotFeatureCollection | undefined;
  historicPerimeters: import('../api/nifcHistory').HistoricPerimeterFC | undefined;
  catalog: MasterCatalog | undefined;
  spreadRun: PyrecastRun | null;
  weatherRun: WeatherRun | null;
  incidentManifest: IncidentManifest | undefined;

  /** Callbacks up into app state. */
  onSelectFire: (corneaId: string) => void;
  onFrameError: () => void; // run-rotation: invalidate catalogs + toast
}

export interface LayerManager {
  /** Add sources/layers (may be called again after style swaps). */
  mount(map: MlMap): void;
  /** Reconcile with the latest context. Must be idempotent + cheap. */
  update(map: MlMap, ctx: LayerContext): void;
  /** Remove sources/layers (only called on hard teardown). */
  unmount(map: MlMap): void;
}
