/**
 * Client state (zustand). `time.currentTime` is THE single time source of
 * truth; every map layer derives its frame from it. Server data lives only in
 * TanStack Query — never duplicated here.
 */
import { create } from 'zustand';
import { resetScope, track, trackOncePer } from '../app/analytics';
import { DEFAULT_PLAYBACK_SPEED } from '../app/config';
import type { Percentile, SpreadProduct, WeatherProduct } from '../api/types';
import { TOA_DEFAULT_WITHIN_HOURS } from '../spread/toaBands';
import type { DirectoryFilter, DirectorySort, DirectorySortKey } from '../directory/rowModel';

/**
 * 'directory' is the app's default: a full-screen roster with no map. 'fire'
 * swaps in the map shell scoped to exactly one incident.
 */
export type ViewState = { mode: 'directory' } | { mode: 'fire'; corneaId: string };

export interface WeatherLayerState {
  visible: boolean;
  opacity: number;
}

/**
 * How the time-of-arrival product paints:
 *   'timeline' — burned-so-far + leading edge, relative to the playhead.
 *   'whole'    — the ENTIRE prediction at once as hours-to-arrival bands,
 *                independent of the playhead, clipped to `toaWithinHours`.
 */
/** Draw-tab feature: a placed symbol marker or a freehand line. */
export interface DrawFeature {
  type: 'Feature';
  geometry:
    | { type: 'Point'; coordinates: [number, number] }
    | { type: 'LineString'; coordinates: [number, number][] };
  properties: {
    fid: string;
    kind: 'marker' | 'line';
    /** Symbol id from the palette (markers only). */
    sym?: string;
    /** Glyph drawn on the map (markers only). */
    glyph?: string;
    /** Marker shape image key ('circle' | 'square' | 'diamond' | 'none'). */
    shape?: string;
    /** Glyph text size (breaks render bigger, disc-less). */
    tsize?: number;
    /** Line style id + derived paint hints (lines only). */
    style?: string;
    dash?: string;
    letter?: string;
    width?: number;
    color: string;
  };
}

export type DrawTool =
  | 'none'
  | 'freehand'
  | 'erase'
  | `marker:${string}`
  | `line:${string}`;

export type ToaMode = 'timeline' | 'whole';

export interface AppState {
  view: ViewState;

  time: {
    currentTime: number; // epoch ms UTC
    domain: [number, number];
    now: number; // sampled every 60 s; past/future seam
    playing: boolean;
    /** Current playback step interval (ms) — the dial glides across it. */
    stepMs: number;
    speed: number; // model-hours per wall-second
    buffering: boolean;
  };

  layers: {
    spread: {
      /**
       * The forecast layer has no user-facing on/off switch: it is simply on
       * whenever fire mode has a run and a product. Kept in the type (layers
       * and the LegendBar read it) but hard-set true on fire select / product
       * change so nothing can strand the layer invisible.
       */
      visible: boolean;
      product: SpreadProduct;
      percentile: Percentile;
      opacity: number;
      /** ToA paint mode (see ToaMode). Persists across fire switches. */
      toaMode: ToaMode;
      /** Whole-mode reach: hide arrivals later than this many hours. */
      toaWithinHours: number;
    };
    weather: Partial<Record<WeatherProduct, WeatherLayerState>>;
    hotspots: { visible: boolean };
    perimeters: { visible: boolean };
    /** NIFC burn-scar context (last 10 years), lazy-fetched when shown. */
    historicPerimeters: { visible: boolean };
    /** Retired with the directory pivot; kept for nationalPerimetersLayer. */
    nationalPerimeters: { visible: boolean };
    incidentMap: {
      mapId: string | null;
      /** Version-series key: scrubbing resolves which sheet is overlaid. */
      series: string | null;
      opacity: number;
    };
    irFlight: { flightId: string | null };
    /** TomTom live traffic flow tiles (needs VITE_TOMTOM_KEY). */
    traffic: { visible: boolean };
    /** TomTom road incidents/closures (needs VITE_TOMTOM_KEY). */
    incidents: { visible: boolean };
  };

  range: {
    origin: { coords: [number, number]; label: string } | null;
    rings: import('../api/routing').RangeRing[];
  };

  directions: {
    a: { coords: [number, number]; label: string } | null;
    b: { coords: [number, number]; label: string } | null;
    profile: import('../api/routing').RouteProfile;
    route: import('../api/routing').RouteResult | null;
    /** Which endpoint the next map click fills, or null. */
    picking: 'a' | 'b' | 'range' | null;
  };

  draw: {
    /** Active tool: none, a marker symbol id, freehand line, or eraser. */
    tool: DrawTool;
    features: DrawFeature[];
    past: DrawFeature[][];
    future: DrawFeature[][];
  };

  ui: {
    theme: 'dark' | 'light';
    sidebarTab: 'overview' | 'forecast' | 'maps' | 'draw';
    /** Basemap ground: vector map (default), satellite, or USGS topo. */
    basemap: 'map' | 'satellite' | 'topo';
    sidebarCollapsed: boolean;
    sheetSnap: 'peek' | 'half' | 'full';
    /** which product's legend the LegendBar shows (qualified key, see LegendBar) */
    legendKey: string | null;
    toast: string | null;
    /**
     * Directory search/filter/sort. Lives in the store (not component state)
     * so entering a fire and coming back restores the roster as it was.
     */
    directory: {
      query: string;
      filter: DirectoryFilter;
      sort: DirectorySort;
    };
  };

  actions: {
    selectFire(corneaId: string): void;
    backToDirectory(): void;
    setTime(t: number): void;
    setStepMs(stepMs: number): void;
    setDomain(domain: [number, number], opts?: { clampCurrent?: boolean }): void;
    sampleNow(): void;
    play(): void;
    pause(): void;
    setSpeed(speed: number): void;
    setBuffering(b: boolean): void;
    setSpreadVisible(visible: boolean): void;
    setSpreadProduct(product: SpreadProduct): void;
    setSpreadPercentile(pct: Percentile): void;
    setSpreadOpacity(opacity: number): void;
    setToaMode(mode: ToaMode): void;
    setToaWithinHours(hours: number): void;
    setWeatherLayer(product: WeatherProduct, state: Partial<WeatherLayerState>): void;
    toggleHotspots(): void;
    togglePerimeters(): void;
    toggleHistoricPerimeters(): void;
    setIncidentMap(mapId: string | null): void;
    /** Put a whole version series on the timeline (clears single-map mode). */
    setIncidentMapSeries(series: string | null): void;
    setIncidentMapOpacity(opacity: number): void;
    setIrFlight(flightId: string | null): void;
    toggleTraffic(): void;
    toggleIncidents(): void;
    setRangeOrigin(p: { coords: [number, number]; label: string } | null): void;
    setRangeRings(rings: import('../api/routing').RangeRing[]): void;
    setDirectionsPoint(which: 'a' | 'b', p: { coords: [number, number]; label: string } | null): void;
    setDirectionsProfile(profile: import('../api/routing').RouteProfile): void;
    setDirectionsRoute(route: import('../api/routing').RouteResult | null): void;
    setDirectionsPicking(which: 'a' | 'b' | 'range' | null): void;
    clearDirections(): void;
    setTheme(theme: 'dark' | 'light'): void;
    setSidebarTab(tab: AppState['ui']['sidebarTab']): void;
    setSidebarCollapsed(collapsed: boolean): void;
    setBasemap(basemap: AppState['ui']['basemap']): void;
    setDrawTool(tool: DrawTool): void;
    /** Replace the feature set, pushing the previous onto the undo stack. */
    drawCommit(features: DrawFeature[]): void;
    drawUndo(): void;
    drawRedo(): void;
    drawClear(): void;
    /** Load persisted features without touching undo history. */
    drawHydrate(features: DrawFeature[]): void;
    setSheetSnap(snap: AppState['ui']['sheetSnap']): void;
    setLegendKey(key: string | null): void;
    showToast(msg: string): void;
    clearToast(): void;
    setDirectoryQuery(query: string): void;
    setDirectoryFilter(filter: DirectoryFilter): void;
    /** Click a column header: same key flips direction, new key starts descending. */
    toggleDirectorySort(key: DirectorySortKey): void;
  };
}

const now = Date.now();

export const useStore = create<AppState>((set, get) => ({
  view: { mode: 'directory' },

  time: {
    currentTime: now,
    domain: [now - 7 * 24 * 3600 * 1000, now + 48 * 3600 * 1000],
    now,
    playing: false,
    stepMs: 0,
    speed: DEFAULT_PLAYBACK_SPEED,
    buffering: false,
  },

  layers: {
    spread: {
      visible: false,
      product: 'time-of-arrival',
      percentile: 50,
      opacity: 0.8,
      toaMode: 'timeline',
      toaWithinHours: TOA_DEFAULT_WITHIN_HOURS,
    },
    weather: {},
    hotspots: { visible: true },
    perimeters: { visible: true },
    historicPerimeters: { visible: false },
    nationalPerimeters: { visible: true },
    incidentMap: { mapId: null, series: null, opacity: 0.75 },
    irFlight: { flightId: null },
    traffic: { visible: false },
    incidents: { visible: false },
  },

  range: { origin: null, rings: [] },

  directions: { a: null, b: null, profile: 'drive', route: null, picking: null },

  draw: { tool: 'none', features: [], past: [], future: [] },

  ui: {
    theme:
      typeof document !== 'undefined'
        ? ((document.documentElement.dataset.theme as 'dark' | 'light') ?? 'dark')
        : 'dark',
    sidebarTab: 'overview',
    basemap: 'map',
    sidebarCollapsed: false,
    sheetSnap: 'peek',
    legendKey: null,
    toast: null,
    directory: { query: '', filter: 'all', sort: { key: 'acres', dir: 'desc' } },
  },

  actions: {
    selectFire: (corneaId) => {
      resetScope('fire-view');
      set((s) => ({
        view: { mode: 'fire', corneaId },
        ui: { ...s.ui, sidebarTab: 'overview', sheetSnap: 'half' },
        // Per-fire view state starts clean on every fire switch (user
        // feedback: carrying layer picks between fires was confusing). A
        // shared URL's params re-apply AFTER this reset, so deep links keep
        // working; the basemap persists — it's a viewing preference.
        time: { ...s.time, currentTime: s.time.now, playing: false },
        layers: {
          ...s.layers,
          spread: { ...s.layers.spread, visible: false },
          weather: {},
          hotspots: { visible: true },
          perimeters: { visible: true },
          historicPerimeters: { visible: false },
          incidentMap: { mapId: null, series: null, opacity: s.layers.incidentMap.opacity },
          irFlight: { flightId: null },
          // traffic (like the basemap) is a viewing preference — persists
        },
        directions: { a: null, b: null, profile: s.directions.profile, route: null, picking: null },
        range: { origin: null, rings: [] },
      }));
    },

    backToDirectory: () =>
      set((s) => ({
        view: { mode: 'directory' },
        time: { ...s.time, playing: false },
        layers: {
          ...s.layers,
          spread: { ...s.layers.spread },
          incidentMap: { mapId: null, series: null, opacity: s.layers.incidentMap.opacity },
          irFlight: { flightId: null },
        },
      })),

    setStepMs: (stepMs) => set((s) => ({ time: { ...s.time, stepMs } })),
    setTime: (t) =>
      set((s) => ({
        time: {
          ...s.time,
          currentTime: Math.min(Math.max(t, s.time.domain[0]), s.time.domain[1]),
        },
      })),

    setDomain: (domain, opts) =>
      set((s) => {
        const clamp = opts?.clampCurrent ?? true;
        const cur = s.time.currentTime;
        const inside = cur >= domain[0] && cur <= domain[1];
        return {
          time: {
            ...s.time,
            domain,
            currentTime: clamp && !inside ? Math.min(Math.max(s.time.now, domain[0]), domain[1]) : cur,
          },
        };
      }),

    sampleNow: () =>
      set((s) => {
        const now = Date.now();
        // A playhead sitting on "now" follows it (so an idle page keeps
        // showing the present, and the shared-URL codec never mistakes the
        // drift between samples for a user scrub). A scrubbed or playing
        // playhead stays put.
        const pinned =
          !s.time.playing && Math.abs(s.time.currentTime - s.time.now) < 2 * 60_000;
        return {
          time: { ...s.time, now, currentTime: pinned ? now : s.time.currentTime },
        };
      }),

    play: () => {
      trackOncePer('fire-view', 'playback_started');
      set((s) => ({ time: { ...s.time, playing: true } }));
    },
    pause: () => set((s) => ({ time: { ...s.time, playing: false, buffering: false } })),
    setSpeed: (speed) => set((s) => ({ time: { ...s.time, speed } })),
    setBuffering: (buffering) => set((s) => ({ time: { ...s.time, buffering } })),

    setSpreadVisible: (visible) =>
      set((s) => ({ layers: { ...s.layers, spread: { ...s.layers.spread, visible } } })),
    setSpreadProduct: (product) =>
      set((s) => ({
        layers: { ...s.layers, spread: { ...s.layers.spread, product, visible: true } },
      })),
    setSpreadPercentile: (percentile) =>
      set((s) => ({ layers: { ...s.layers, spread: { ...s.layers.spread, percentile } } })),
    setSpreadOpacity: (opacity) =>
      set((s) => ({ layers: { ...s.layers, spread: { ...s.layers.spread, opacity } } })),
    setToaMode: (toaMode) =>
      set((s) => ({ layers: { ...s.layers, spread: { ...s.layers.spread, toaMode } } })),
    setToaWithinHours: (toaWithinHours) =>
      set((s) => ({ layers: { ...s.layers, spread: { ...s.layers.spread, toaWithinHours } } })),

    setWeatherLayer: (product, state) => {
      if (state.visible !== undefined
          && state.visible !== (get().layers.weather[product]?.visible ?? false)) {
        track('layer_toggled', { layer: product, on: state.visible });
      }
      set((s) => {
        const prev = s.layers.weather[product] ?? { visible: false, opacity: 0.7 };
        return {
          layers: {
            ...s.layers,
            weather: { ...s.layers.weather, [product]: { ...prev, ...state } },
          },
        };
      });
    },

    toggleHotspots: () => {
      track('layer_toggled', { layer: 'hotspots', on: !get().layers.hotspots.visible });
      set((s) => ({
        layers: { ...s.layers, hotspots: { visible: !s.layers.hotspots.visible } },
      }));
    },
    togglePerimeters: () => {
      track('layer_toggled', { layer: 'perimeters', on: !get().layers.perimeters.visible });
      set((s) => ({
        layers: { ...s.layers, perimeters: { visible: !s.layers.perimeters.visible } },
      }));
    },

    toggleHistoricPerimeters: () => {
      track('layer_toggled', { layer: 'historic_perimeters',
                              on: !get().layers.historicPerimeters.visible });
      set((s) => ({
        layers: {
          ...s.layers,
          historicPerimeters: { visible: !s.layers.historicPerimeters.visible },
        },
      }));
    },

    setIncidentMap: (mapId) => {
      if (mapId) track('map_overlay_shown', { kind: 'sheet' });
      set((s) => ({
        layers: {
          ...s.layers,
          incidentMap: { ...s.layers.incidentMap, mapId, series: null },
        },
      }));
    },
    setIncidentMapSeries: (series) => {
      if (series) track('map_overlay_shown', { kind: 'series' });
      set((s) => ({
        layers: {
          ...s.layers,
          incidentMap: { ...s.layers.incidentMap, mapId: null, series },
        },
      }));
    },
    setIncidentMapOpacity: (opacity) =>
      set((s) => ({
        layers: { ...s.layers, incidentMap: { ...s.layers.incidentMap, opacity } },
      })),
    setIrFlight: (flightId) => {
      if (flightId) track('map_overlay_shown', { kind: 'ir' });
      set((s) => ({ layers: { ...s.layers, irFlight: { flightId } } }));
    },

    toggleTraffic: () => {
      track('layer_toggled', { layer: 'traffic', on: !get().layers.traffic.visible });
      set((s) => ({
        layers: { ...s.layers, traffic: { visible: !s.layers.traffic.visible } },
      }));
    },

    setDirectionsPoint: (which, p) =>
      set((s) => ({
        directions: { ...s.directions, [which]: p, route: null, picking: null },
      })),
    toggleIncidents: () => {
      track('layer_toggled', { layer: 'incidents', on: !get().layers.incidents.visible });
      set((s) => ({
        layers: { ...s.layers, incidents: { visible: !s.layers.incidents.visible } },
      }));
    },
    setRangeOrigin: (p) =>
      set((s) => ({
        range: { origin: p, rings: p ? s.range.rings : [] },
        directions: { ...s.directions, picking: null },
      })),
    setRangeRings: (rings) => set((s) => ({ range: { ...s.range, rings } })),
    setDirectionsProfile: (profile) =>
      set((s) => ({ directions: { ...s.directions, profile, route: null } })),
    setDirectionsRoute: (route) =>
      set((s) => ({ directions: { ...s.directions, route } })),
    setDirectionsPicking: (which) =>
      set((s) => ({ directions: { ...s.directions, picking: which } })),
    clearDirections: () =>
      set((s) => ({
        directions: { a: null, b: null, profile: s.directions.profile, route: null, picking: null },
      })),

    setTheme: (theme) => {
      document.documentElement.dataset.theme = theme;
      try {
        localStorage.setItem('rd-theme', theme);
      } catch {
        /* private mode */
      }
      set((s) => ({ ui: { ...s.ui, theme } }));
    },
    setSidebarTab: (sidebarTab) => set((s) => ({ ui: { ...s.ui, sidebarTab } })),
    setSidebarCollapsed: (sidebarCollapsed) => set((s) => ({ ui: { ...s.ui, sidebarCollapsed } })),
    setBasemap: (basemap) => {
      track('basemap_changed', { basemap });
      set((s) => ({ ui: { ...s.ui, basemap } }));
    },
    setDrawTool: (tool) => {
      if (tool !== 'none' && tool !== 'erase') {
        trackOncePer('fire-view', 'draw_used', { tool: tool.split(':')[0] });
      }
      set((s) => ({ draw: { ...s.draw, tool } }));
    },
    drawCommit: (features) =>
      set((s) => ({
        draw: {
          ...s.draw,
          features,
          past: [...s.draw.past, s.draw.features].slice(-50),
          future: [],
        },
      })),
    drawUndo: () =>
      set((s) => {
        const past = s.draw.past;
        if (!past.length) return {};
        return {
          draw: {
            ...s.draw,
            features: past[past.length - 1],
            past: past.slice(0, -1),
            future: [s.draw.features, ...s.draw.future],
          },
        };
      }),
    drawRedo: () =>
      set((s) => {
        const future = s.draw.future;
        if (!future.length) return {};
        return {
          draw: {
            ...s.draw,
            features: future[0],
            past: [...s.draw.past, s.draw.features],
            future: future.slice(1),
          },
        };
      }),
    drawClear: () =>
      set((s) =>
        s.draw.features.length
          ? {
              draw: {
                ...s.draw,
                features: [],
                past: [...s.draw.past, s.draw.features].slice(-50),
                future: [],
              },
            }
          : {},
      ),
    drawHydrate: (features) =>
      set(() => ({ draw: { tool: 'none', features, past: [], future: [] } })),
    setSheetSnap: (sheetSnap) => set((s) => ({ ui: { ...s.ui, sheetSnap } })),
    setLegendKey: (legendKey) => set((s) => ({ ui: { ...s.ui, legendKey } })),
    showToast: (toast) => {
      set((s) => ({ ui: { ...s.ui, toast } }));
      setTimeout(() => {
        if (get().ui.toast === toast) set((s) => ({ ui: { ...s.ui, toast: null } }));
      }, 5000);
    },
    clearToast: () => set((s) => ({ ui: { ...s.ui, toast: null } })),

    setDirectoryQuery: (query) =>
      set((s) => ({ ui: { ...s.ui, directory: { ...s.ui.directory, query } } })),
    setDirectoryFilter: (filter) =>
      set((s) => ({ ui: { ...s.ui, directory: { ...s.ui.directory, filter } } })),
    toggleDirectorySort: (key) =>
      set((s) => {
        const cur = s.ui.directory.sort;
        const sort: DirectorySort =
          cur.key === key
            ? { key, dir: cur.dir === 'desc' ? 'asc' : 'desc' }
            : { key, dir: 'desc' };
        return { ui: { ...s.ui, directory: { ...s.ui.directory, sort } } };
      }),
  },
}));

/** Convenience hooks */
export const useActions = () => useStore((s) => s.actions);
export const useView = () => useStore((s) => s.view);
export const useCurrentTime = () => useStore((s) => s.time.currentTime);

// DEV diagnostics: expose the store for browser-automation testing.
if (import.meta.env.DEV && typeof window !== 'undefined') {
  (window as unknown as { __rdStore: typeof useStore }).__rdStore = useStore;
}
