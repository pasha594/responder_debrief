/**
 * Client state (zustand). `time.currentTime` is THE single time source of
 * truth; every map layer derives its frame from it. Server data lives only in
 * TanStack Query — never duplicated here.
 */
import { create } from 'zustand';
import { resetScope, track, trackOncePer } from '../app/analytics';
import { DEFAULT_BASEMAP, DEFAULT_PLAYBACK_SPEED } from '../app/config';
import type { Percentile, SpreadProduct, WeatherProduct } from '../api/types';
import type { ShareCamera, ShareState } from '../share/shareCodec';
import { TOA_DEFAULT_WITHIN_HOURS } from '../spread/toaBands';
import type { DirectoryFilter, DirectoryNear, DirectorySort, DirectorySortKey } from '../directory/rowModel';
import { DEFAULT_DIRECTORY_SORT } from '../directory/rowModel';
import { MAP_STYLES } from '../app/config';

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
  /** Marks saved before the NWCG palette also carry paint hints (glyph,
   * color, dash, …); rendering reads only the ids, so those are ignored. */
  properties: {
    fid: string;
    kind: 'marker' | 'line';
    /** NWCG point symbol id (markers only). */
    sym?: string;
    /** Map-relative heading, degrees clockwise from north, for symbols that
     * turn with the map (the map's bearing when placed, so they land upright). */
    rot?: number;
    /** Line style id (lines only). */
    style?: string;
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
    /** USGS National Digital Trails overlay (online only). */
    trails: { visible: boolean };
    /** TomTom road incidents/closures (needs VITE_TOMTOM_KEY). */
    incidents: { visible: boolean };
  };

  range: {
    rings: import('../api/routing').RangeRing[];
  };

  /** Browser geolocation: latest fix + whether live tracking is on. */
  location: {
    coords: [number, number] | null;
    accuracy: number | null;
    tracking: boolean;
  };

  directions: {
    a: { coords: [number, number]; label: string } | null;
    b: { coords: [number, number]; label: string } | null;
    profile: import('../api/routing').RouteProfile;
    route: import('../api/routing').RouteResult | null;
    /** Map clicks fill route slots only while the search UI is engaged. */
    armed: boolean;
  };

  /** Google-style dropped pin [lon, lat]: a plain click on an idle map marks
   * a spot and opens its card (see panels/DroppedPin). */
  droppedPin: [number, number] | null;

  draw: {
    /** Active tool: none, a marker symbol id, freehand line, or eraser. */
    tool: DrawTool;
    features: DrawFeature[];
    past: DrawFeature[][];
    future: DrawFeature[][];
  };

  offline: {
    /** Downloaded packs by fire slug (hydrated from OPFS at boot). */
    packs: Record<string, import('../offline/packs').PackMeta>;
    /** Active download, or null. */
    progress: { corneaId: string; done: number; total: number; bytes: number } | null;
    /** navigator.onLine mirror (App keeps it current). */
    online: boolean;
  };

  /** QR sharing between phones (see share/). */
  share: {
    /** A scanned or linked share, shown for the user to Apply or dismiss. */
    incoming: ShareState | null;
    /**
     * The parts of an applied share that wait on something else: the camera
     * on the map (useMapLayerSync), the playhead on the fire's timeline
     * domain (SharedPlayheadSync), the drawings on the draw layer loading the
     * fire's own marks first (drawLayer). Each part is cleared as it lands;
     * leaving the fire drops the rest.
     */
    pending: {
      corneaId: string;
      camera: ShareCamera | null;
      time: number | null;
      drawings: DrawFeature[] | null;
      /** Date.now() when applied (a playhead still waiting gives up after 30 s). */
      at: number;
    } | null;
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
      /** Proximity mode: only fires near this place, closest first. */
      near: DirectoryNear | null;
    };
    /** Chosen basemap style id per theme (see MAP_STYLES). */
    mapStyle: { dark: string; light: string };
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
    toggleTrails(): void;
    toggleIncidents(): void;
    setRangeRings(rings: import('../api/routing').RangeRing[]): void;
    setLocationFix(coords: [number, number] | null, accuracy: number | null): void;
    setLocationTracking(tracking: boolean): void;
    setDirectionsPoint(which: 'a' | 'b', p: { coords: [number, number]; label: string } | null): void;
    setDirectionsProfile(profile: import('../api/routing').RouteProfile): void;
    setDirectionsRoute(route: import('../api/routing').RouteResult | null): void;
    setDirectionsArmed(armed: boolean): void;
    clearDirections(): void;
    dropPin(coords: [number, number]): void;
    clearDroppedPin(): void;
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
    /** Enter/leave "near <place>" mode; entering sorts by distance. */
    setDirectoryNear(near: DirectoryNear | null): void;
    setMapStyle(theme: 'dark' | 'light', id: string): void;
    setOfflinePacks(packs: Record<string, import('../offline/packs').PackMeta>): void;
    setOfflineProgress(p: AppState['offline']['progress']): void;
    setOnline(online: boolean): void;
    setIncomingShare(share: ShareState | null): void;
    /**
     * Make the open fire's view match a share: layers, basemap and sheet at
     * once; camera, playhead and drawings through `share.pending`. Only acts
     * when that fire is the one open (share/applyShare selects it first).
     */
    applySharedView(share: ShareState): void;
    /** One pending part of an applied share has landed (or was overtaken). */
    settleShared(part: 'camera' | 'time' | 'drawings'): void;
  };
}

const now = Date.now();

/** True while the next map click will claim a route endpoint (exactly one
 * slot missing, or the bar focused with none set) — feature popups yield. */
export function routeClickClaims(d: AppState['directions']): boolean {
  return (!!d.a !== !!d.b) || (d.armed && !d.a && !d.b);
}

/** An armed draw tool only makes sense while the Draw tab's palette is on
 * screen — anything that takes the panel off that tab disarms it, so map taps
 * go back to being taps. Marks and undo history stay. Identity is kept when
 * already idle: the draw layer re-renders on slice identity. */
function disarmDraw(draw: AppState['draw']): AppState['draw'] {
  return draw.tool === 'none' ? draw : { ...draw, tool: 'none' };
}

/**
 * Per-theme basemap style, persisted like the theme itself. Unknown or
 * removed ids fall back to each theme's default (the first catalog entry).
 */
function initMapStyle(): { dark: string; light: string } {
  const pick = (theme: 'dark' | 'light'): string => {
    const fallback = MAP_STYLES[theme][0].id;
    // Everything inside the try: even `typeof localStorage` can throw when
    // the browser blocks storage access (sandboxed frames, cookie blocking).
    try {
      if (typeof localStorage === 'undefined') return fallback;
      const saved = localStorage.getItem(`rd-map-style-${theme}`);
      return saved && MAP_STYLES[theme].some((st) => st.id === saved) ? saved : fallback;
    } catch {
      return fallback;
    }
  };
  return { dark: pick('dark'), light: pick('light') };
}

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
    trails: { visible: false },
    incidents: { visible: false },
  },

  range: { rings: [] },

  location: { coords: null, accuracy: null, tracking: false },

  directions: { a: null, b: null, profile: 'drive', route: null, armed: false },

  droppedPin: null,

  draw: { tool: 'none', features: [], past: [], future: [] },

  offline: {
    packs: {},
    progress: null,
    online: typeof navigator === 'undefined' ? true : navigator.onLine,
  },

  share: { incoming: null, pending: null },

  ui: {
    theme:
      typeof document !== 'undefined'
        ? ((document.documentElement.dataset.theme as 'dark' | 'light') ?? 'dark')
        : 'dark',
    sidebarTab: 'overview',
    basemap: DEFAULT_BASEMAP,
    sidebarCollapsed: false,
    sheetSnap: 'peek',
    legendKey: null,
    toast: null,
    directory: { query: '', filter: 'all', sort: DEFAULT_DIRECTORY_SORT, near: null },
    mapStyle: initMapStyle(),
  },

  actions: {
    selectFire: (corneaId) => {
      resetScope('fire-view');
      set((s) => ({
        view: { mode: 'fire', corneaId },
        ui: { ...s.ui, sidebarTab: 'overview', sheetSnap: 'half' },
        // The tab snaps back to Overview — same rule as setSidebarTab. (A NEW
        // fire's hydrate resets the tool anyway; re-selecting the open fire
        // doesn't re-hydrate.)
        draw: disarmDraw(s.draw),
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
        directions: {
          a: null, b: null, profile: s.directions.profile,
          route: null, armed: false, picking: null,
        },
        droppedPin: null,
        range: { rings: [] },
        // a share still landing belongs to the fire it was applied to
        share: { ...s.share, pending: null },

  location: { coords: null, accuracy: null, tracking: false },
      }));
    },

    backToDirectory: () =>
      set((s) => ({
        view: { mode: 'directory' },
        draw: disarmDraw(s.draw),
        droppedPin: null,
        share: { ...s.share, pending: null },
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

    // One map overlay at a time: an incident sheet (or series) and an IR
    // flight replace each other rather than stacking.
    setIncidentMap: (mapId) => {
      if (mapId) track('map_overlay_shown', { kind: 'sheet' });
      set((s) => ({
        layers: {
          ...s.layers,
          incidentMap: { ...s.layers.incidentMap, mapId, series: null },
          irFlight: mapId ? { flightId: null } : s.layers.irFlight,
        },
      }));
    },
    setIncidentMapSeries: (series) => {
      if (series) track('map_overlay_shown', { kind: 'series' });
      set((s) => ({
        layers: {
          ...s.layers,
          incidentMap: { ...s.layers.incidentMap, mapId: null, series },
          irFlight: series ? { flightId: null } : s.layers.irFlight,
        },
      }));
    },
    setIncidentMapOpacity: (opacity) =>
      set((s) => ({
        layers: { ...s.layers, incidentMap: { ...s.layers.incidentMap, opacity } },
      })),
    setIrFlight: (flightId) => {
      if (flightId) track('map_overlay_shown', { kind: 'ir' });
      set((s) => ({
        layers: {
          ...s.layers,
          irFlight: { flightId },
          incidentMap: flightId
            ? { ...s.layers.incidentMap, mapId: null, series: null }
            : s.layers.incidentMap,
        },
      }));
    },

    toggleTraffic: () => {
      track('layer_toggled', { layer: 'traffic', on: !get().layers.traffic.visible });
      set((s) => ({
        layers: { ...s.layers, traffic: { visible: !s.layers.traffic.visible } },
      }));
    },

    toggleTrails: () => {
      track('layer_toggled', { layer: 'trails', on: !get().layers.trails.visible });
      set((s) => ({
        layers: { ...s.layers, trails: { visible: !s.layers.trails.visible } },
      }));
    },

    setDirectionsPoint: (which, p) =>
      set((s) => ({
        directions: { ...s.directions, [which]: p, route: null },
        // Directions own map clicks from here (and "Directions" on the pin
        // card hands its spot over as B).
        droppedPin: p ? null : s.droppedPin,
      })),
    setDirectionsArmed: (armed) =>
      set((s) => ({ directions: { ...s.directions, armed } })),
    toggleIncidents: () => {
      track('layer_toggled', { layer: 'incidents', on: !get().layers.incidents.visible });
      set((s) => ({
        layers: { ...s.layers, incidents: { visible: !s.layers.incidents.visible } },
      }));
    },
    setRangeRings: (rings) => set(() => ({ range: { rings } })),
    setLocationFix: (coords, accuracy) =>
      set((s) => ({ location: { ...s.location, coords, accuracy } })),
    setLocationTracking: (tracking) =>
      set((s) => ({
        location: tracking
          ? { ...s.location, tracking }
          : { coords: null, accuracy: null, tracking: false },
      })),
    setDirectionsProfile: (profile) =>
      set((s) => ({ directions: { ...s.directions, profile, route: null } })),
    setDirectionsRoute: (route) =>
      set((s) => ({ directions: { ...s.directions, route } })),
    clearDirections: () =>
      set((s) => ({
        directions: {
          a: null, b: null, profile: s.directions.profile,
          route: null, armed: false,
        },
        range: { rings: [] },

  location: { coords: null, accuracy: null, tracking: false },
      })),

    dropPin: (coords) => set(() => ({ droppedPin: coords })),
    clearDroppedPin: () => set(() => ({ droppedPin: null })),

    setTheme: (theme) => {
      track('theme_changed', { theme });
      document.documentElement.dataset.theme = theme;
      try {
        localStorage.setItem('rd-theme', theme);
      } catch {
        /* private mode */
      }
      set((s) => ({ ui: { ...s.ui, theme } }));
    },
    setSidebarTab: (sidebarTab) =>
      set((s) => ({
        ui: { ...s.ui, sidebarTab },
        draw: sidebarTab === 'draw' ? s.draw : disarmDraw(s.draw),
      })),
    setSidebarCollapsed: (sidebarCollapsed) => set((s) => ({ ui: { ...s.ui, sidebarCollapsed } })),
    setBasemap: (basemap) => {
      track('basemap_changed', { basemap });
      set((s) => ({ ui: { ...s.ui, basemap } }));
    },
    setDrawTool: (tool) => {
      if (tool !== 'none' && tool !== 'erase') {
        trackOncePer('fire-view', 'draw_used', { tool: tool.split(':')[0] });
      }
      set((s) => ({
        draw: { ...s.draw, tool },
        droppedPin: tool === 'none' ? s.droppedPin : null,
      }));
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
    setDirectoryNear: (near) =>
      set((s) => {
        const cur = s.ui.directory.sort;
        // A freshly resolved city leads with the closest fires (the headers
        // reflect and can re-sort this); clearing drops the now-meaningless
        // distance sort back to the default.
        const sort: DirectorySort = near
          ? { key: 'distance', dir: 'asc' }
          : cur.key === 'distance'
            ? DEFAULT_DIRECTORY_SORT
            : cur;
        return { ui: { ...s.ui, directory: { ...s.ui.directory, near, sort } } };
      }),
    setOfflinePacks: (packs) => set((s) => ({ offline: { ...s.offline, packs } })),
    setOfflineProgress: (progress) => set((s) => ({ offline: { ...s.offline, progress } })),
    setOnline: (online) =>
      set((s) => (s.offline.online === online ? s : { offline: { ...s.offline, online } })),
    setIncomingShare: (incoming) => set((s) => ({ share: { ...s.share, incoming } })),
    applySharedView: (share) =>
      set((s) => {
        if (s.view.mode !== 'fire' || s.view.corneaId !== share.fire.corneaId) return {};
        const L = share.layers;
        // every weather layer the share doesn't name goes off (opacity kept)
        const weather: AppState['layers']['weather'] = {};
        for (const [p, st] of Object.entries(s.layers.weather) as [WeatherProduct, WeatherLayerState][]) {
          weather[p] = { ...st, visible: false };
        }
        for (const [p, opacity] of Object.entries(L.weather) as [WeatherProduct, number][]) {
          weather[p] = { visible: true, opacity };
        }
        return {
          layers: {
            ...s.layers,
            spread: { ...L.spread },
            weather,
            hotspots: { visible: L.hotspots },
            perimeters: { visible: L.perimeters },
            historicPerimeters: { visible: L.historic },
            traffic: { visible: L.traffic },
            incidents: { visible: L.incidents },
            incidentMap: { ...L.incidentMap },
            irFlight: { flightId: L.irFlight },
          },
          ui: { ...s.ui, basemap: share.basemap },
          // A "now" share follows the recipient's clock; a scrubbed playhead
          // waits in `pending` for a timeline domain that reaches it.
          time: {
            ...s.time,
            playing: false,
            ...(share.time == null ? { currentTime: s.time.now } : {}),
          },
          share: {
            incoming: null,
            pending: {
              corneaId: share.fire.corneaId,
              camera: share.camera,
              time: share.time,
              drawings: share.drawings,
              at: Date.now(),
            },
          },
        };
      }),
    settleShared: (part) =>
      set((s) => {
        const p = s.share.pending;
        if (!p || p[part] == null) return {};
        const next = { ...p, [part]: null };
        const done = next.camera == null && next.time == null && next.drawings == null;
        return { share: { ...s.share, pending: done ? null : next } };
      }),
    setMapStyle: (theme, id) => {
      track('map_style_changed', { theme, style: id });
      try {
        localStorage.setItem(`rd-map-style-${theme}`, id);
      } catch {
        /* private mode */
      }
      set((s) => ({ ui: { ...s.ui, mapStyle: { ...s.ui.mapStyle, [theme]: id } } }));
    },
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
