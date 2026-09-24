export type HotspotInput =
  | GeoJSON.FeatureCollection<GeoJSON.Point>
  | Array<GeoJSON.Feature<GeoJSON.Point>>
  | Array<{ lng?: number; lon?: number; longitude?: number; lat?: number; latitude?: number; [key: string]: unknown }>
  | Array<[number, number]>;

export interface FireColors {
  ember: string;
  base: string;
  mid: string;
  tip: string;
  puff: string;
  puffEnd: string;
}

export interface FireLayerOptions {
  id?: string;
  hotspots?: HotspotInput;

  /** Flame height in metres. */
  size?: number;
  minPixelSize?: number;
  maxPixelSize?: number;
  /** Size multiplier at intensity 0 and at intensity 1. */
  intensityScale?: [number, number];

  minZoom?: number;
  zoomFade?: number;

  colors?: Partial<FireColors>;
  core?: number;
  opacity?: number;

  /** Tongues per flame, 1..8. */
  spikes?: number;
  thickness?: number;
  /** How far the side tongues stand from the middle one. */
  spread?: number;
  /** Facets around each tongue, 3..8. */
  sides?: number;
  /** Small embers per flame, 0..8. */
  sparks?: number;

  /** Master rate for all motion. */
  speed?: number;
  /** Sideways flutter at the tip, in flame heights. */
  jiggle?: number;
  jiggleSpeed?: number;
  /** Strength of the bulges that stream up each tongue. */
  flow?: number;
  flowSpeed?: number;
  /** How far a tip stretches before it lets go. */
  flicker?: number;
  /** How far a released tip climbs while it burns away, in flame heights. */
  rise?: number;
  riseSpeed?: number;
  /** `from` is meteorological: 270 = wind from the west. */
  wind?: { from: number; strength: number } | null;
  /** Flames tilt back so they never look flatter than on a map pitched this much. 0 = always vertical. */
  minApparentPitch?: number;

  quality?: 'auto' | 0 | 1 | 2 | 3;
  vertexBudget?: 'auto' | number;
  adaptive?: boolean;
  respectReducedMotion?: boolean;

  followTerrain?: boolean;
  getIntensity?: (properties: Record<string, any>) => number;
  getTime?: (properties: Record<string, any>) => number;
  getAltitude?: (properties: Record<string, any>) => number | null | undefined;
  getSize?: (properties: Record<string, any>) => number | null | undefined;
}

export interface FireLayerStats {
  flames: number;
  visible: number;
  lod: number;
  vertices: number;
  drawCalls: number;
  frameMs: number;
}

export class FireLayer {
  constructor(options?: FireLayerOptions);
  readonly id: string;
  readonly type: 'custom';
  readonly renderingMode: '3d';
  options: Required<Omit<FireLayerOptions, 'hotspots'>>;

  setHotspots(data: HotspotInput | null): this;
  setOptions(options: Partial<FireLayerOptions>): this;
  /** Show only hotspots detected within [from, to]. Call with no arguments to show all. */
  setTimeRange(from?: number | null, to?: number | null): this;
  pause(): this;
  resume(): this;
  getStats(): FireLayerStats;

  onAdd(map: unknown, gl: WebGLRenderingContext | WebGL2RenderingContext): void;
  onRemove(map: unknown, gl: WebGLRenderingContext | WebGL2RenderingContext): void;
  render(gl: WebGLRenderingContext | WebGL2RenderingContext, args: unknown): void;
}

export default FireLayer;
