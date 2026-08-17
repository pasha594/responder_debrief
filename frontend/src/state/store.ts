/**
 * Client state (zustand). `time.currentTime` is THE single time source of
 * truth; every map layer derives its frame from it. Server data lives only in
 * TanStack Query — never duplicated here.
 */
import { create } from 'zustand';
import { DEFAULT_PLAYBACK_SPEED } from '../app/config';
import type { Percentile, SpreadProduct, WeatherProduct } from '../api/types';

export type ViewState = { mode: 'national' } | { mode: 'fire'; corneaId: string };

export interface WeatherLayerState {
  visible: boolean;
  opacity: number;
}

export interface AppState {
  view: ViewState;

  time: {
    currentTime: number; // epoch ms UTC
    domain: [number, number];
    now: number; // sampled every 60 s; past/future seam
    playing: boolean;
    speed: number; // model-hours per wall-second
    buffering: boolean;
  };

  layers: {
    spread: {
      visible: boolean;
      product: SpreadProduct;
      percentile: Percentile;
      opacity: number;
    };
    weather: Partial<Record<WeatherProduct, WeatherLayerState>>;
    hotspots: { visible: boolean };
    perimeters: { visible: boolean };
    nationalPerimeters: { visible: boolean };
    incidentMap: { mapId: string | null; opacity: number };
    irFlight: { flightId: string | null };
  };

  ui: {
    theme: 'dark' | 'light';
    sidebarTab: 'overview' | 'forecast' | 'weather' | 'maps';
    sidebarCollapsed: boolean;
    sheetSnap: 'peek' | 'half' | 'full';
    /** which product's legend the LegendBar shows (qualified key, see LegendBar) */
    legendKey: string | null;
    toast: string | null;
  };

  actions: {
    selectFire(corneaId: string): void;
    backToNational(): void;
    setTime(t: number): void;
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
    setWeatherLayer(product: WeatherProduct, state: Partial<WeatherLayerState>): void;
    toggleHotspots(): void;
    togglePerimeters(): void;
    setIncidentMap(mapId: string | null): void;
    setIncidentMapOpacity(opacity: number): void;
    setIrFlight(flightId: string | null): void;
    setTheme(theme: 'dark' | 'light'): void;
    setSidebarTab(tab: AppState['ui']['sidebarTab']): void;
    setSidebarCollapsed(collapsed: boolean): void;
    setSheetSnap(snap: AppState['ui']['sheetSnap']): void;
    setLegendKey(key: string | null): void;
    showToast(msg: string): void;
    clearToast(): void;
  };
}

const now = Date.now();

export const useStore = create<AppState>((set, get) => ({
  view: { mode: 'national' },

  time: {
    currentTime: now,
    domain: [now - 7 * 24 * 3600 * 1000, now + 48 * 3600 * 1000],
    now,
    playing: false,
    speed: DEFAULT_PLAYBACK_SPEED,
    buffering: false,
  },

  layers: {
    spread: { visible: true, product: 'time-of-arrival', percentile: 50, opacity: 0.8 },
    weather: {},
    hotspots: { visible: true },
    perimeters: { visible: true },
    nationalPerimeters: { visible: true },
    incidentMap: { mapId: null, opacity: 0.75 },
    irFlight: { flightId: null },
  },

  ui: {
    theme: (document.documentElement.dataset.theme as 'dark' | 'light') ?? 'dark',
    sidebarTab: 'overview',
    sidebarCollapsed: false,
    sheetSnap: 'peek',
    legendKey: null,
    toast: null,
  },

  actions: {
    selectFire: (corneaId) =>
      set((s) => ({
        view: { mode: 'fire', corneaId },
        ui: { ...s.ui, sidebarTab: 'overview', sheetSnap: 'half' },
        layers: {
          ...s.layers,
          incidentMap: { mapId: null, opacity: s.layers.incidentMap.opacity },
          irFlight: { flightId: null },
        },
      })),

    backToNational: () =>
      set((s) => ({
        view: { mode: 'national' },
        time: { ...s.time, playing: false },
        layers: {
          ...s.layers,
          spread: { ...s.layers.spread },
          incidentMap: { mapId: null, opacity: s.layers.incidentMap.opacity },
          irFlight: { flightId: null },
        },
      })),

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

    sampleNow: () => set((s) => ({ time: { ...s.time, now: Date.now() } })),

    play: () => set((s) => ({ time: { ...s.time, playing: true } })),
    pause: () => set((s) => ({ time: { ...s.time, playing: false, buffering: false } })),
    setSpeed: (speed) => set((s) => ({ time: { ...s.time, speed } })),
    setBuffering: (buffering) => set((s) => ({ time: { ...s.time, buffering } })),

    setSpreadVisible: (visible) =>
      set((s) => ({ layers: { ...s.layers, spread: { ...s.layers.spread, visible } } })),
    setSpreadProduct: (product) =>
      set((s) => ({ layers: { ...s.layers, spread: { ...s.layers.spread, product } } })),
    setSpreadPercentile: (percentile) =>
      set((s) => ({ layers: { ...s.layers, spread: { ...s.layers.spread, percentile } } })),
    setSpreadOpacity: (opacity) =>
      set((s) => ({ layers: { ...s.layers, spread: { ...s.layers.spread, opacity } } })),

    setWeatherLayer: (product, state) =>
      set((s) => {
        const prev = s.layers.weather[product] ?? { visible: false, opacity: 0.7 };
        return {
          layers: {
            ...s.layers,
            weather: { ...s.layers.weather, [product]: { ...prev, ...state } },
          },
        };
      }),

    toggleHotspots: () =>
      set((s) => ({
        layers: { ...s.layers, hotspots: { visible: !s.layers.hotspots.visible } },
      })),
    togglePerimeters: () =>
      set((s) => ({
        layers: { ...s.layers, perimeters: { visible: !s.layers.perimeters.visible } },
      })),

    setIncidentMap: (mapId) =>
      set((s) => ({
        layers: { ...s.layers, incidentMap: { ...s.layers.incidentMap, mapId } },
      })),
    setIncidentMapOpacity: (opacity) =>
      set((s) => ({
        layers: { ...s.layers, incidentMap: { ...s.layers.incidentMap, opacity } },
      })),
    setIrFlight: (flightId) =>
      set((s) => ({ layers: { ...s.layers, irFlight: { flightId } } })),

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
    setSheetSnap: (sheetSnap) => set((s) => ({ ui: { ...s.ui, sheetSnap } })),
    setLegendKey: (legendKey) => set((s) => ({ ui: { ...s.ui, legendKey } })),
    showToast: (toast) => {
      set((s) => ({ ui: { ...s.ui, toast } }));
      setTimeout(() => {
        if (get().ui.toast === toast) set((s) => ({ ui: { ...s.ui, toast: null } }));
      }, 5000);
    },
    clearToast: () => set((s) => ({ ui: { ...s.ui, toast: null } })),
  },
}));

/** Convenience hooks */
export const useActions = () => useStore((s) => s.actions);
export const useView = () => useStore((s) => s.view);
export const useCurrentTime = () => useStore((s) => s.time.currentTime);
