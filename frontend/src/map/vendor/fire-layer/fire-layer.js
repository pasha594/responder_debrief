/**
 * fire-layer.js — GPU-instanced low-poly 3D flames for MapLibre GL JS (v3 – v6).
 *
 * Zero dependencies. Every flame is one instance of a small shared mesh and all
 * motion happens in the vertex shader, so the per-frame CPU cost is a handful
 * of uniforms regardless of how many hotspots are on the map.
 *
 *   import { FireLayer } from './fire-layer.js';
 *
 *   const fire = new FireLayer({ id: 'fire', hotspots: viirsGeoJSON });
 *   map.on('load', () => map.addLayer(fire));   // optionally: addLayer(fire, 'first-label-layer-id')
 *   fire.setHotspots(nextGeoJSON);              // replace the data at any time
 */

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
const EARTH_CIRCUMFERENCE = 40075016.68557849;

const CLOCK_WRAP = 64;       // every shader frequency is a whole number of cycles per wrap, so wrapping never shows
const VERTEX_FLOATS = 12;    // axis.xy, z, t | dir.xy, radius, normal.z | kind, phase, gain, bias
const INSTANCE_FLOATS = 9;   // dx, dy, elevation, scale, seed, intensity, cos, sin, time
const CHUNK = 64;            // instances per culling chunk
const TERRAIN_STEP = 256;    // elevation lookups per frame while catching up with the terrain

const KIND_BED = 0;
const KIND_TONGUE = 1;
const KIND_LICK = 2;         // a tip that has let go of its tongue and is burning away
const KIND_SPARK = 3;

const DEFAULTS = {
  id: 'fire-layer',

  // --- size
  size: 100,                  // height of the tallest tongue in metres (a VIIRS pixel is ~375 m)
  minPixelSize: 4,            // ...but never drawn smaller than this many CSS px
  maxPixelSize: 200,          // ...nor larger than this
  intensityScale: [0.8, 1.3], // size multiplier at intensity 0 and at intensity 1

  // --- zoom
  minZoom: 4,                 // nothing is drawn (and nothing animates) below this zoom
  zoomFade: 1.5,              // flames grow in over this many zoom levels above minZoom

  // --- shape
  spikes: 5,                  // tongues per flame, 1..8
  thickness: 0.93,            // girth of the tongues
  spread: 1.27,               // how far the side tongues stand from the middle one
  sides: 4,                   // facets around each tongue, 3..8
  sparks: 3,                  // small embers per flame, 0..8

  // --- motion
  speed: 0.56,                // master rate for everything below
  jiggle: 0,                  // sideways flutter at the tip, in flame heights
  jiggleSpeed: 0.37,
  flow: 0.07,                 // strength of the bulges that stream up each tongue
  flowSpeed: 3.6,
  flicker: 0.43,              // how far a tip stretches before it lets go
  rise: 0.55,                 // how far a released tip climbs while it burns away, in flame heights
  riseSpeed: 1.22,
  wind: null,                 // { from: degrees (meteorological, 270 = from the west), strength: 0..1 }
  minApparentPitch: 22,       // flames tilt back so they never look flatter than a map pitched this much; 0 = always vertical

  // --- colour
  colors: {
    ember: '#c92f0a',         // rim of the glowing bed
    base: '#ff560a',          // bottom of a tongue
    mid: '#ffa01e',
    tip: '#ffe05c',
    puff: '#ffd23f',          // sparks when they appear
    puffEnd: '#fff3bf'        // anything that has left the flame, just before it vanishes
  },
  core: 0.96,                 // 0..1 brightness of the hot core on faces turned to the viewer
  opacity: 1,

  // --- performance
  quality: 'auto',            // 'auto', or a fixed level 0 (richest) .. 3 (lightest)
  vertexBudget: 'auto',       // vertices per frame that 'auto' quality may spend
  adaptive: true,             // drop a quality level when frames run long
  respectReducedMotion: true, // hold flames still for users who ask for reduced motion

  // --- data
  followTerrain: true,        // sit on 3D terrain when the map has it
  getIntensity: defaultIntensity,
  getTime: defaultTime,
  getAltitude: (p) => p.altitude, // metres; overrides the terrain lookup for that hotspot
  getSize: (p) => p.size          // optional per-hotspot size multiplier
};

// ---------------------------------------------------------------------------
// Data accessors
// ---------------------------------------------------------------------------

function defaultIntensity(p) {
  if (p.intensity != null) return +p.intensity;
  if (p.frp != null) return Math.log10(1 + Math.max(0, +p.frp)) / 2.5; // VIIRS fire radiative power, MW
  return 0.5;
}

function defaultTime(p) {
  const t = p.time != null ? p.time : p.timestamp;
  if (t != null) return typeof t === 'number' ? t : Date.parse(t);
  if (p.acq_date) { // NASA FIRMS: acq_date "2026-09-15", acq_time "436" (UTC, HHMM)
    const hhmm = String(p.acq_time != null ? p.acq_time : '0').padStart(4, '0');
    return Date.parse(`${p.acq_date}T${hhmm.slice(0, 2)}:${hhmm.slice(2)}:00Z`);
  }
  return NaN;
}

// ---------------------------------------------------------------------------
// Web mercator helpers (same convention as maplibregl.MercatorCoordinate)
// ---------------------------------------------------------------------------

const mercX = (lng) => (180 + lng) / 360;
const mercY = (lat) => (180 - (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))) / 360;
const mercPerMeter = (lat) => 1 / (EARTH_CIRCUMFERENCE * Math.cos(lat * DEG));

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const fract = (v) => v - Math.floor(v);

function parseColor(c) {
  if (Array.isArray(c)) return c[0] > 1 || c[1] > 1 || c[2] > 1 ? [c[0] / 255, c[1] / 255, c[2] / 255] : c;
  let h = String(c).trim().replace('#', '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const n = parseInt(h, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

// Interleave the low 16 bits of x and y (Z-order curve) so that sorting by the
// key keeps neighbouring hotspots next to each other in the instance buffer.
function morton(x, y) {
  x = (x | (x << 8)) & 0x00ff00ff; x = (x | (x << 4)) & 0x0f0f0f0f;
  x = (x | (x << 2)) & 0x33333333; x = (x | (x << 1)) & 0x55555555;
  y = (y | (y << 8)) & 0x00ff00ff; y = (y | (y << 4)) & 0x0f0f0f0f;
  y = (y | (y << 2)) & 0x33333333; y = (y | (y << 1)) & 0x55555555;
  return ((y << 1) | x) >>> 0;
}

// ---------------------------------------------------------------------------
// Flame mesh
//
// A flame is a glowing bed, a cluster of low-poly tongues, one "lick" per
// tongue (the tip it keeps shedding) and a few sparks, merged into one indexed
// mesh per quality level. A tongue vertex is stored as a point on the tongue's
// axis plus a radial direction and a radius, which lets the shader change the
// girth, and send bulges up the flame, without touching the mesh.
// ---------------------------------------------------------------------------

// Smallest on-screen flame, in px, that still earns each quality level (0 = richest).
const LOD_MIN_PX = [34, 20, 12, 0];

const OCTA = {
  verts: [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]],
  faces: [[0, 2, 4], [2, 1, 4], [1, 3, 4], [3, 0, 4], [2, 0, 5], [1, 2, 5], [3, 1, 5], [0, 3, 5]]
};

// Radius of a tongue along its height: a belly low down, then a slightly hollow taper to a point.
function tongueProfile(t) {
  const swell = 0.62 + 0.38 * Math.sin((Math.min(t / 0.22, 1) * Math.PI) / 2);
  return t <= 0.22 ? swell : swell * Math.pow(1 - (t - 0.22) / 0.78, 1.25);
}

// Tongue k of n. The first stands in the middle at full height; the rest ring it, each shorter than the last.
function tongueLayout(k, n) {
  if (k === 0) return { x: 0, y: 0, height: 1, radius: 0.27, phase: 0, gain: 1, bias: 0 };
  const a = k * 2.399963 + 0.5; // golden angle: evenly spread for any n
  const d = 0.17 + 0.025 * ((k * 7) % 3);
  const height = 0.74 - (0.34 * (k - 1)) / Math.max(1, n - 2);
  return {
    x: d * Math.cos(a), y: d * Math.sin(a), height, radius: 0.27 * (0.5 + 0.5 * height),
    phase: fract(k * 0.618034), gain: 1 + (1 - height) * 0.9, bias: -0.12 * (1 - height)
  };
}

// Push a triangle wound counter-clockwise as seen from outside the part.
function pushTri(tris, base, pts, a, b, c, centre) {
  const A = pts[a], B = pts[b], C = pts[c];
  const ux = B[0] - A[0], uy = B[1] - A[1], uz = B[2] - A[2];
  const vx = C[0] - A[0], vy = C[1] - A[1], vz = C[2] - A[2];
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const ox = (A[0] + B[0] + C[0]) / 3 - centre[0];
  const oy = (A[1] + B[1] + C[1]) / 3 - centre[1];
  const oz = (A[2] + B[2] + C[2]) / 3 - centre[2];
  if (nx * ox + ny * oy + nz * oz >= 0) tris.push(base + a, base + b, base + c);
  else tris.push(base + a, base + c, base + b);
}

// A surface of revolution with alternate rings twisted half a step, which
// gives the faceted look more evenly shaped triangles.
function addLathe(verts, tris, o) {
  const base = verts.length / VERTEX_FLOATS;
  const rows = o.profile.length;
  const pts = [];
  const rowStart = [];
  for (let j = 0; j < rows; j++) {
    const [t, r] = o.profile[j];
    const tip = j === rows - 1 && r === 0;
    const [t0, r0] = o.profile[Math.max(0, j - 1)];
    const [t1, r1] = o.profile[Math.min(rows - 1, j + 1)];
    const dz = (t1 - t0) * o.height;
    const dr = (r1 - r0) * o.radius;
    const nz = tip ? 1 : -dr / (Math.hypot(dz, dr) || 1);
    rowStart.push(pts.length);
    for (let i = 0; i < (tip ? 1 : o.sides); i++) {
      const a = ((i + (j % 2) * 0.5) / o.sides) * TAU + o.phase * TAU;
      const ca = Math.cos(a), sa = Math.sin(a);
      pts.push([o.x + ca * r * o.radius, o.y + sa * r * o.radius, t * o.height]);
      verts.push(o.x, o.y, t * o.height, t, ca, sa, r * o.radius, nz, o.kind, o.phase, o.gain, o.bias);
    }
  }
  const centre = [o.x, o.y, o.height * 0.35 - (o.kind === KIND_BED ? 1 : 0)];
  for (let j = 0; j < rows - 1; j++) {
    const lo = rowStart[j], hi = rowStart[j + 1];
    const closing = j === rows - 2 && o.profile[rows - 1][1] === 0;
    for (let i = 0; i < o.sides; i++) {
      const i1 = (i + 1) % o.sides;
      if (closing) {
        pushTri(tris, base, pts, lo + i, lo + i1, hi, centre);
      } else if (j % 2 === 0) { // the upper ring is the twisted one
        pushTri(tris, base, pts, lo + i, lo + i1, hi + i, centre);
        pushTri(tris, base, pts, lo + i1, hi + i1, hi + i, centre);
      } else {
        pushTri(tris, base, pts, lo + i, lo + i1, hi + i1, centre);
        pushTri(tris, base, pts, lo + i, hi + i1, hi + i, centre);
      }
    }
  }
}

// An octahedron that the shader moves, stretches and shrinks: a lick or a spark.
function addLoose(verts, tris, kind, emit, radius, phase, gain, rnd) {
  const base = verts.length / VERTEX_FLOATS;
  for (const v of OCTA.verts) verts.push(emit[0], emit[1], emit[2], rnd, v[0], v[1], radius, v[2], kind, phase, gain, 0);
  for (const f of OCTA.faces) pushTri(tris, base, OCTA.verts, f[0], f[1], f[2], [0, 0, 0]);
}

function buildFlameMesh(level, o) {
  const spikes = clamp(Math.round(o.spikes), 1, 8);
  const sides = clamp(Math.round(o.sides), 3, 8);
  const sparks = clamp(Math.round(o.sparks), 0, 8);
  const spec = [
    { tongues: spikes, sides, rows: 7, licks: spikes, sparks, bedRows: 2 },
    { tongues: Math.min(spikes, 4), sides: Math.min(sides, 5), rows: 5, licks: Math.min(spikes, 3), sparks: Math.min(sparks, 2), bedRows: 1 },
    { tongues: Math.min(spikes, 2), sides: Math.min(sides, 4), rows: 4, licks: 1, sparks: Math.min(sparks, 1), bedRows: 0 },
    { tongues: 1, sides: Math.min(sides, 4), rows: 3, licks: 1, sparks: 0, bedRows: 0 }
  ][level];

  const verts = [];
  const tris = [];
  if (spec.bedRows) { // unit radius; the shader sizes it to fit under the tongues
    const profile = spec.bedRows === 2 ? [[0, 1], [0.7, 0.6], [1, 0]] : [[0, 1], [1, 0]];
    addLathe(verts, tris, { kind: KIND_BED, sides: spec.sides + 1, profile, height: 0.1, radius: 1, x: 0, y: 0, phase: 0.11, gain: 1, bias: 0 });
  }
  for (let k = 0; k < spec.tongues; k++) {
    const tongue = tongueLayout(k, spikes);
    const profile = [];
    for (let j = 0; j < spec.rows; j++) {
      const t = Math.pow(j / (spec.rows - 1), 1.35); // rings crowd toward the belly
      profile.push([t, j === spec.rows - 1 ? 0 : tongueProfile(t)]);
    }
    addLathe(verts, tris, { kind: KIND_TONGUE, sides: spec.sides, profile, ...tongue });
    // Same phase and gain as its tongue: that is what ties the lick's birth to the tip snapping off.
    if (k < spec.licks) addLoose(verts, tris, KIND_LICK, [tongue.x, tongue.y, tongue.height], tongue.radius * 0.52, tongue.phase, tongue.gain, fract(k * 0.37));
  }
  for (let s = 0; s < spec.sparks; s++) {
    const a = s * 2.399963;
    addLoose(verts, tris, KIND_SPARK, [0.09 * Math.cos(a), 0.09 * Math.sin(a), 0.35 + 0.15 * (s % 3)],
      0.034 + 0.012 * (s % 2), (s + 0.5) / spec.sparks, 1, fract(s * 0.618));
  }
  return { vertices: new Float32Array(verts), indices: new Uint16Array(tris), vertexCount: verts.length / VERTEX_FLOATS };
}

// ---------------------------------------------------------------------------
// Shaders — GLSL ES 1.00, so one source serves WebGL1 and WebGL2 contexts
// ---------------------------------------------------------------------------

const cycles = (n) => ((TAU * n) / CLOCK_WRAP).toFixed(6); // n whole cycles per clock wrap, as radians per unit
const turns = (n) => (n / CLOCK_WRAP).toFixed(6);

const VERTEX_SHADER = `
precision highp float;

attribute vec4 a_pos;      // bed/tongue: xy = the part's axis, z = height, w = 0..1 along the part
                           // lick/spark: xyz = where it starts, w = random
attribute vec4 a_rad;      // bed/tongue: xy = unit direction away from the axis, z = radius, w = z of the normal
                           // lick/spark: xyw = unit octahedron vertex, z = radius
attribute vec4 a_part;     // x = kind (0 bed, 1 tongue, 2 lick, 3 spark), y = phase, z = gain, w = colour bias

attribute vec4 a_i0;       // xy = mercator offset from the data origin, z = ground elevation (m), w = mercator units per metre
attribute vec4 a_i1;       // x = seed, y = intensity, zw = cos/sin of the flame's heading
attribute float a_i2;      // detection time (s after the earliest hotspot)

uniform mat4 u_matrix;     // mercator -> clip, re-centred near the camera (see FireLayer.render)
uniform vec4 u_cam;        // xy = camera offset from the data origin, z = elevation datum (m), w = mercator units per metre at the map centre
uniform vec4 u_frame;      // xy = direction on the ground that points up the screen, zw = sin/cos of the lean angle
uniform vec3 u_view;       // unit vector from the ground toward the camera
uniform vec4 u_size;       // x = CSS px per mercator unit, y = min px, z = max px, w = global scale
uniform vec4 u_scale;      // x = flame height (m), yz = size multiplier at intensity 0 and 1, w = core strength
uniform vec4 u_shape;      // x = thickness, y = spread, z = bed radius
uniform vec4 u_motion;     // x = jiggle, y = flow, z = flicker, w = rise
uniform vec3 u_clock;      // jiggle, flow and rise clocks
uniform vec4 u_wind;       // xy = wind push at the tip (east, south), zw = visible time range
uniform vec3 u_cEmber;
uniform vec3 u_cBase;
uniform vec3 u_cMid;
uniform vec3 u_cTip;
uniform vec3 u_cPuff;
uniform vec3 u_cPuffEnd;

varying vec3 v_color;

const float TAU = 6.28318530718;
const vec3 LIGHT = vec3(-0.45, -0.55, 0.70);

void main() {
  float kind = a_part.x;
  float isBed = 1.0 - step(0.5, kind);
  float isSpark = step(2.5, kind);
  float isLick = step(1.5, kind) - isSpark;
  float isLoose = isLick + isSpark;
  float isTongue = 1.0 - isBed - isLoose;
  float gain = a_part.z;
  float seed = a_i1.x;
  float heat = a_i1.y;
  float t = a_pos.w * (1.0 - isLoose);
  float ph = (seed + a_part.y) * TAU;

  // Jiggle: a quick sideways flutter that ripples upward and grows toward the tip.
  float j1 = sin(u_clock.x * ${cycles(83)} - t * 4.0 + ph);
  float j2 = sin(u_clock.x * ${cycles(131)} - t * 5.5 + ph * 1.618 + 1.7);
  vec2 jiggle = vec2(j1 + 0.5 * j2, j2 - 0.5 * j1) * (u_motion.x * gain);

  // Flow: bulges that climb the tongue, so its outline keeps streaming upward.
  float f1 = sin(t * 10.0 - u_clock.y * ${cycles(97)} + ph * 1.3);
  float f2 = sin(t * 17.0 - u_clock.y * ${cycles(151)} + ph * 2.1);
  float flowing = u_motion.y * smoothstep(0.0, 0.3, t);
  float bulge = 1.0 + flowing * (0.65 * f1 + 0.35 * f2);

  // Each tongue slowly stretches its tip, then lets it go. Its lick runs on the
  // same cycle, so the lick is born where and when the tip snaps back.
  float cycle = fract(u_clock.z * ${turns(37)} + a_part.y + seed * 3.0);
  float reach = u_motion.z * gain;
  float stretch = reach * (min(cycle / 0.8, (1.0 - cycle) / 0.2) - 0.5);

  vec3 pTongue = vec3(a_pos.xy * u_shape.y + a_rad.xy * (a_rad.z * u_shape.x * bulge)
                        + jiggle * (t * t) + vec2(f2, f1) * (flowing * 0.1 * t),
                      a_pos.z * (1.0 + stretch * t));

  // Licks and sparks: start full size, climb, drift, and shrink to nothing.
  float life = mix(cycle, fract(u_clock.z * ${turns(53)} + a_part.y + seed * 5.0), isSpark);
  float radius = a_rad.z * mix(u_shape.x, 1.0, isSpark) * (1.0 - life);
  vec3 blob = vec3(a_rad.xy, a_rad.w);
  blob.z *= mix(mix(1.1, 2.8, step(0.0, blob.z)), 1.0, isSpark); // a lick is a teardrop: short below, long and pointed above
  float startZ = mix(a_pos.z * (1.0 + 0.5 * reach) - 1.3 * a_rad.z * u_shape.x, a_pos.z, isSpark);
  vec3 pLoose = vec3(a_pos.xy * u_shape.y * (1.0 + isSpark * 1.5 * life) + jiggle * (0.4 + 1.4 * life),
                     startZ + u_motion.w * mix(1.0, 1.7, isSpark) * life * (2.0 - life)) + blob * radius;

  vec3 pBed = vec3(a_rad.xy * (a_rad.z * u_shape.z * (1.0 + 0.04 * j2)), a_pos.z);

  vec3 p = pBed * isBed + pTongue * isTongue + pLoose * isLoose;
  vec3 n = mix(vec3(a_rad.xy * sqrt(max(0.0, 1.0 - a_rad.w * a_rad.w)), a_rad.w), vec3(a_rad.xy, a_rad.w), isLoose);

  // Give every flame its own heading, then let the wind push it over.
  vec2 rot = a_i1.zw;
  p.xy = vec2(p.x * rot.x - p.y * rot.y, p.x * rot.y + p.y * rot.x);
  n.xy = vec2(n.x * rot.x - n.y * rot.y, n.x * rot.y + n.y * rot.x);
  p.xy += u_wind.xy * (isTongue * t * t + isLoose * (0.6 + 1.6 * life));

  // Lean back, away from the camera, so a flame seen from straight above
  // still reads as a flame instead of a dot. The bed stays on the ground.
  vec2 up = u_frame.xy;
  vec2 right = vec2(-up.y, up.x);
  float sl = u_frame.z * (1.0 - isBed);
  float cl = mix(u_frame.w, 1.0, isBed);
  float pu = dot(p.xy, up);
  float nu = dot(n.xy, up);
  vec3 wp = vec3(right * dot(p.xy, right) + up * (pu * cl + p.z * sl), p.z * cl - pu * sl);
  vec3 wn = vec3(right * dot(n.xy, right) + up * (nu * cl + n.z * sl), n.z * cl - nu * sl);

  // Real-world size, clamped to a pixel range, scaled by intensity, hidden outside the time range.
  float px = clamp(a_i0.w * u_scale.x * u_size.x, u_size.y, u_size.z);
  float scale = px / u_size.x * u_size.w * mix(u_scale.y, u_scale.z, heat);
  scale *= step(u_wind.z, a_i2) * step(a_i2, u_wind.w);

  // Subtracting two nearby float32 offsets is exact, which keeps flames rock
  // steady at high zoom even though absolute mercator coordinates are not.
  vec3 anchor = vec3(a_i0.xy - u_cam.xy, (a_i0.z - u_cam.z) * u_cam.w);
  gl_Position = u_matrix * vec4(anchor + wp * scale, 1.0);

  float facing = max(dot(wn, u_view), 0.0);
  float g = clamp(t + a_part.w + (heat - 0.5) * 0.35 + 0.07 * f1 * flowing, 0.0, 1.0);
  vec3 cTongue = mix(u_cBase, u_cMid, smoothstep(0.0, 0.55, g));
  cTongue = mix(cTongue, u_cTip, smoothstep(0.45, 1.0, g));
  cTongue = mix(cTongue, u_cTip, facing * facing * u_scale.w * (1.0 - 0.6 * t));
  vec3 cLoose = mix(mix(u_cTip, u_cPuff, isSpark), u_cPuffEnd, life);
  vec3 cBed = mix(u_cEmber, u_cBase, a_pos.w) * (0.9 + 0.1 * j1);
  v_color = (cBed * isBed + cTongue * isTongue + cLoose * isLoose) * (0.93 + 0.07 * dot(wn, LIGHT));
}`;

const FRAGMENT_SHADER = `
precision mediump float;
varying vec3 v_color;
uniform float u_opacity;
void main() {
  gl_FragColor = vec4(v_color * u_opacity, u_opacity);
}`;

const ATTRIBUTES = ['a_pos', 'a_rad', 'a_part', 'a_i0', 'a_i1', 'a_i2'];
const UNIFORMS = ['u_matrix', 'u_cam', 'u_frame', 'u_view', 'u_size', 'u_scale', 'u_shape', 'u_motion', 'u_clock',
  'u_wind', 'u_cEmber', 'u_cBase', 'u_cMid', 'u_cTip', 'u_cPuff', 'u_cPuffEnd', 'u_opacity'];

function autoVertexBudget() {
  if (typeof navigator === 'undefined' || typeof matchMedia === 'undefined') return 300000;
  if (!matchMedia('(pointer: coarse)').matches) return 300000;
  const weak = (navigator.hardwareConcurrency || 4) <= 4 || (navigator.deviceMemory || 4) <= 2;
  return weak ? 60000 : 120000;
}

// ---------------------------------------------------------------------------
// The layer
// ---------------------------------------------------------------------------

export class FireLayer {
  constructor(options = {}) {
    this.options = { ...DEFAULTS, ...options, colors: { ...DEFAULTS.colors, ...(options.colors || {}) } };
    delete this.options.hotspots;
    this.id = this.options.id;
    this.type = 'custom';
    this.renderingMode = '3d';

    this.map = null;
    this._program = null;
    this._unsupported = false;
    this._count = 0;
    this._instances = null;
    this._lngLat = null;
    this._fixedAltitude = null;
    this._chunks = null;
    this._origin = [0, 0];
    this._timeBase = 0;
    this._timeRange = null;
    this._scaleMax = 0;
    this._dataDirty = false;

    // terrain following
    this._relativeZ = false;
    this._terrainDirty = false;
    this._terrainEager = false;
    this._awaitIdle = false;
    this._elevated = false;
    this._pass = null;
    this._subLo = Infinity;
    this._subHi = -1;
    this._probe = { lng: 0, lat: 0, wrap() { return this; } };

    // animation
    this._clock = [0, 0, 0]; // jiggle, flow, rise
    this._lods = null;
    this._meshKey = '';
    this._lastRender = 0;
    this._paused = false;
    this._reducedMotion = false;
    this._frameMs = 16;
    this._slowFor = 0;
    this._fastFor = 0;
    this._lodBias = 0;
    this._lod = 0;
    this._budget = 0;
    this._runs = [];
    this._m32 = new Float32Array(16);
    this._stats = { flames: 0, visible: 0, lod: 0, vertices: 0, drawCalls: 0, frameMs: 0 };

    this._onContextLost = () => { this._program = null; this._lods = null; };
    this._onContextRestored = () => this._repaint();
    this._onTerrain = () => { this._terrainDirty = true; this._awaitIdle = true; this._repaint(); };
    this._onMoveEnd = () => { this._terrainDirty = true; this._awaitIdle = true; };
    this._onIdle = () => { if (this._awaitIdle) { this._awaitIdle = false; this._terrainDirty = true; this._repaint(); } };
    this._onMotionPref = (e) => { this._reducedMotion = e.matches; this._repaint(); };

    if (options.hotspots) this.setHotspots(options.hotspots);
  }

  // ---- public API ---------------------------------------------------------

  /**
   * Replace the hotspots. Accepts a GeoJSON FeatureCollection of Points, an
   * array of Point features, or an array of { lng, lat, ... } / [lng, lat].
   */
  setHotspots(data) {
    const o = this.options;
    let items = data || [];
    if (items.type === 'FeatureCollection') items = items.features || [];
    else if (items.type === 'Feature') items = [items];

    const total = items.length;
    const x = new Float64Array(total), y = new Float64Array(total);
    const lng = new Float64Array(total), lat = new Float64Array(total);
    const heat = new Float32Array(total), alt = new Float32Array(total), sizeF = new Float32Array(total);
    const time = new Float64Array(total);
    let n = 0, minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, minT = Infinity;

    for (let i = 0; i < total; i++) {
      const it = items[i];
      if (!it) continue;
      let px, py, props = it;
      if (it.geometry) {
        if (it.geometry.type !== 'Point') continue;
        px = it.geometry.coordinates[0]; py = it.geometry.coordinates[1]; props = it.properties || {};
      } else if (Array.isArray(it)) {
        px = it[0]; py = it[1]; props = {};
      } else {
        px = it.lng != null ? it.lng : it.lon != null ? it.lon : it.longitude;
        py = it.lat != null ? it.lat : it.latitude;
      }
      px = +px; py = +py;
      if (!isFinite(px) || !isFinite(py) || Math.abs(py) > 85.05) continue;

      lng[n] = px; lat[n] = py;
      x[n] = mercX(px); y[n] = mercY(py);
      heat[n] = clamp(+o.getIntensity(props) || 0, 0, 1);
      const a = o.getAltitude(props);
      alt[n] = a == null || !isFinite(+a) ? NaN : +a;
      const s = o.getSize(props);
      sizeF[n] = s == null || !isFinite(+s) ? 1 : +s;
      const tm = +o.getTime(props);
      time[n] = tm;
      if (tm < minT) minT = tm;
      if (x[n] < minX) minX = x[n];
      if (x[n] > maxX) maxX = x[n];
      if (y[n] < minY) minY = y[n];
      if (y[n] > maxY) maxY = y[n];
      n++;
    }

    this._count = n;
    this._stats.flames = n;
    this._pass = null;
    if (!n) { this._instances = null; this._chunks = null; this._repaint(); return this; }

    // Z-order sort: chunks of consecutive instances become compact patches of
    // ground that can be culled against the viewport with one test each.
    const spanX = Math.max(maxX - minX, 1e-12), spanY = Math.max(maxY - minY, 1e-12);
    const keys = new Float64Array(n);
    const order = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      keys[i] = morton(((x[i] - minX) / spanX * 65535) | 0, ((y[i] - minY) / spanY * 65535) | 0);
      order[i] = i;
    }
    order.sort((a, b) => keys[a] - keys[b]);

    const ox = (minX + maxX) / 2, oy = (minY + maxY) / 2;
    const inst = new Float32Array(n * INSTANCE_FLOATS);
    const lngLat = new Float64Array(n * 2);
    const fixed = new Uint8Array(n);
    const chunks = new Float64Array(Math.ceil(n / CHUNK) * 4);
    let scaleMax = 0;
    this._timeBase = isFinite(minT) ? minT : 0;

    for (let k = 0; k < n; k++) {
      const i = order[k];
      const j = k * INSTANCE_FLOATS;
      // Randomness comes from the location, so a hotspot keeps its look when the data is replaced.
      const seed = fract(Math.sin(lng[i] * 127.1 + lat[i] * 311.7) * 43758.5453);
      const heading = fract(seed * 7.13 + 0.37) * TAU;
      inst[j] = x[i] - ox;
      inst[j + 1] = y[i] - oy;
      inst[j + 2] = isNaN(alt[i]) ? 0 : alt[i];
      inst[j + 3] = mercPerMeter(lat[i]) * sizeF[i];
      inst[j + 4] = seed;
      inst[j + 5] = heat[i];
      inst[j + 6] = Math.cos(heading);
      inst[j + 7] = Math.sin(heading);
      inst[j + 8] = isFinite(time[i]) ? (time[i] - this._timeBase) / 1000 : 0;
      lngLat[k * 2] = lng[i];
      lngLat[k * 2 + 1] = lat[i];
      fixed[k] = isNaN(alt[i]) ? 0 : 1;
      if (inst[j + 3] > scaleMax) scaleMax = inst[j + 3];

      const c = ((k / CHUNK) | 0) * 4;
      if (k % CHUNK === 0) { chunks[c] = chunks[c + 2] = x[i]; chunks[c + 1] = chunks[c + 3] = y[i]; }
      if (x[i] < chunks[c]) chunks[c] = x[i];
      if (y[i] < chunks[c + 1]) chunks[c + 1] = y[i];
      if (x[i] > chunks[c + 2]) chunks[c + 2] = x[i];
      if (y[i] > chunks[c + 3]) chunks[c + 3] = y[i];
    }

    this._origin = [ox, oy];
    this._instances = inst;
    this._lngLat = lngLat;
    this._fixedAltitude = fixed;
    this._chunks = chunks;
    this._scaleMax = scaleMax;
    this._dataDirty = true;
    this._elevated = false;
    this._terrainDirty = true;
    this._terrainEager = true; // new flames find the ground at once instead of trickling in
    this._repaint();
    return this;
  }

  /** Change any option after construction. Data accessors apply from the next setHotspots(). */
  setOptions(options) {
    const colors = { ...this.options.colors, ...(options.colors || {}) };
    Object.assign(this.options, options, { colors });
    this._repaint();
    return this;
  }

  /** Only show hotspots detected within [from, to] (same units as getTime; ms by default). Call with no arguments to show all. */
  setTimeRange(from, to) {
    this._timeRange = from == null || to == null ? null : [+from, +to];
    this._repaint();
    return this;
  }

  pause() { this._paused = true; return this; }
  resume() { this._paused = false; this._repaint(); return this; }

  /** Counters from the most recent frame. */
  getStats() { return { ...this._stats }; }

  // ---- MapLibre custom layer interface ------------------------------------

  // GL objects are created on the first render rather than here: render() is
  // the one place where MapLibre has parked its own vertex array state.
  onAdd(map) {
    this.map = map;
    map.on('webglcontextlost', this._onContextLost);
    map.on('webglcontextrestored', this._onContextRestored);
    map.on('terrain', this._onTerrain);
    map.on('moveend', this._onMoveEnd);
    map.on('idle', this._onIdle);
    if (typeof matchMedia !== 'undefined') {
      this._motionQuery = matchMedia('(prefers-reduced-motion: reduce)');
      this._reducedMotion = this._motionQuery.matches;
      if (this._motionQuery.addEventListener) this._motionQuery.addEventListener('change', this._onMotionPref);
    }
    this._terrainDirty = true;
  }

  onRemove(map, gl) {
    map.off('webglcontextlost', this._onContextLost);
    map.off('webglcontextrestored', this._onContextRestored);
    map.off('terrain', this._onTerrain);
    map.off('moveend', this._onMoveEnd);
    map.off('idle', this._onIdle);
    if (this._motionQuery && this._motionQuery.removeEventListener) this._motionQuery.removeEventListener('change', this._onMotionPref);
    if (this._program) {
      this._disposeMeshes(gl);
      gl.deleteBuffer(this._instanceBuffer);
      gl.deleteProgram(this._program);
    }
    this._program = null;
    this.map = null;
  }

  render(gl, args) {
    const o = this.options;
    const map = this.map;
    if (!map || !this._count || this._unsupported) return;

    // MapLibre 5+ passes an object; 3/4 pass the matrix itself, with heights
    // measured from the terrain under the map centre instead of from sea level.
    let matrix = null;
    let relativeZ = false;
    if (args && args.defaultProjectionData) {
      const pd = args.defaultProjectionData;
      matrix = pd.projectionTransition > 0 && pd.fallbackMatrix ? pd.fallbackMatrix : pd.mainMatrix;
    } else if (args && args.length === 16) {
      matrix = args;
      relativeZ = true;
    }
    if (!matrix) return;
    this._relativeZ = relativeZ;

    const zoom = map.getZoom();
    const fade = o.zoomFade > 0 ? clamp((zoom - o.minZoom) / o.zoomFade, 0, 1) : +(zoom >= o.minZoom);
    if (fade <= 0 || o.opacity <= 0) { this._stats.visible = 0; this._stats.drawCalls = 0; return; }

    if (!this._program) {
      this._initGL(gl);
      if (!this._program) return;
    }
    this._syncMeshes(gl);

    // Animation clock, and a governor that sheds detail when frames run long.
    const now = performance.now();
    const dt = now - this._lastRender;
    this._lastRender = now;
    const animating = !this._paused && o.speed > 0 && !(o.respectReducedMotion && this._reducedMotion);
    if (animating) {
      const step = (Math.min(dt, 100) / 1000) * o.speed;
      this._clock[0] = (this._clock[0] + step * o.jiggleSpeed) % CLOCK_WRAP;
      this._clock[1] = (this._clock[1] + step * o.flowSpeed) % CLOCK_WRAP;
      this._clock[2] = (this._clock[2] + step * o.riseSpeed) % CLOCK_WRAP;
    }
    if (animating && dt < 250) {
      this._frameMs += (dt - this._frameMs) * 0.1;
      if (this._frameMs > 42) { this._slowFor += dt; this._fastFor = 0; }      // below ~24 fps
      else if (this._frameMs < 24) { this._fastFor += dt; this._slowFor = 0; } // comfortably above 40
      if (o.adaptive && this._slowFor > 2500 && this._lodBias < 2) { this._lodBias++; this._slowFor = 0; }
      if ((this._fastFor > 4000 || !o.adaptive) && this._lodBias > 0) { this._lodBias--; this._fastFor = 0; }
    }

    // Camera.
    const center = map.getCenter();
    const cx = mercX(center.lng), cy = mercY(center.lat);
    const pitch = map.getPitch() * DEG;
    const bearing = map.getBearing() * DEG;
    const upX = Math.sin(bearing), upY = -Math.cos(bearing);
    const lean = Math.max(0, o.minApparentPitch * DEG - pitch);
    const pxPerMerc = 512 * Math.pow(2, zoom);
    const scaleHi = Math.max(o.intensityScale[0], o.intensityScale[1]);

    // Which chunks touch the viewport? Consecutive visible chunks merge into
    // runs, and each run becomes one instanced draw call.
    const reach = (clamp(this._scaleMax * o.size * pxPerMerc, o.minPixelSize, o.maxPixelSize) / pxPerMerc) * scaleHi * 3;
    const b = map.getBounds();
    const x0 = mercX(b.getWest()) - reach, x1 = mercX(b.getEast()) + reach;
    const y0 = mercY(clamp(b.getNorth(), -85, 85)) - reach, y1 = mercY(clamp(b.getSouth(), -85, 85)) + reach;
    const wraps = map.getRenderWorldCopies && map.getRenderWorldCopies() === false;

    const runs = this._runs;
    runs.length = 0;
    let visible = 0;
    const chunks = this._chunks;
    const chunkCount = chunks.length / 4;
    for (let k = wraps ? 0 : -1; k <= (wraps ? 0 : 1); k++) {
      if (x1 < k || x0 > k + 1) continue;
      let start = -1;
      for (let c = 0; c <= chunkCount; c++) {
        const i = c * 4;
        const hit = c < chunkCount && chunks[i + 2] + k >= x0 && chunks[i] + k <= x1 && chunks[i + 3] >= y0 && chunks[i + 1] <= y1;
        if (hit && start < 0) start = c;
        if (!hit && start >= 0) {
          const first = start * CHUNK;
          const count = Math.min(c * CHUNK, this._count) - first;
          runs.push(k, first, count);
          visible += count;
          start = -1;
        }
      }
    }

    this._followTerrain();
    this._upload(gl);

    this._stats.visible = visible;
    this._stats.frameMs = this._frameMs;
    if (!visible) {
      this._stats.drawCalls = 0;
      this._stats.vertices = 0;
      if (this._pass) this._repaint();
      return;
    }

    // Quality: the richest mesh that the flame's on-screen size justifies and the vertex budget affords.
    let lod;
    if (o.quality === 'auto') {
      const flamePx = clamp(o.size * mercPerMeter(center.lat) * pxPerMerc, o.minPixelSize, o.maxPixelSize) * fade;
      if (!this._budget) this._budget = autoVertexBudget();
      const budget = o.vertexBudget === 'auto' ? this._budget : o.vertexBudget;
      lod = 0;
      // The current level keeps a little slack so zooming around a threshold does not flip-flop.
      while (lod < 3 && flamePx < LOD_MIN_PX[lod] * (lod === this._lod ? 0.9 : 1)) lod++;
      while (lod < 3 && visible * this._lods[lod].vertexCount > budget) lod++;
      lod = Math.min(3, lod + this._lodBias);
    } else {
      lod = clamp(o.quality | 0, 0, 3);
    }
    this._lod = lod;
    const mesh = this._lods[lod];

    // GL state. MapLibre re-syncs its own state after a custom layer, so nothing needs restoring.
    gl.useProgram(this._program);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(true);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.frontFace(gl.CW); // mercator y points south, which mirrors the mesh's counter-clockwise faces
    if (o.opacity < 1) { gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); } else gl.disable(gl.BLEND);

    const u = this._uniforms;
    const c = o.colors;
    const wind = o.wind && o.wind.strength ? o.wind : null;
    const windFrom = wind ? (wind.from || 0) * DEG : 0;
    const windPush = wind ? clamp(wind.strength, 0, 1) * 0.6 : 0;
    const range = this._timeRange;
    gl.uniform4f(u.u_frame, upX, upY, Math.sin(lean), Math.cos(lean));
    gl.uniform3f(u.u_view, -upX * Math.sin(pitch), -upY * Math.sin(pitch), Math.cos(pitch));
    gl.uniform4f(u.u_size, pxPerMerc, o.minPixelSize, o.maxPixelSize, fade);
    gl.uniform4f(u.u_scale, o.size, o.intensityScale[0], o.intensityScale[1], o.core);
    // The bed is sized to sit under the feet of the tongues, however thick or spread out they are.
    gl.uniform4f(u.u_shape, o.thickness, o.spread, (o.spikes > 1 ? 0.17 * o.spread : 0) + 0.23 * o.thickness + 0.03, 0);
    gl.uniform4f(u.u_motion, o.jiggle, o.flow, o.flicker, o.rise);
    gl.uniform3f(u.u_clock, this._clock[0], this._clock[1], this._clock[2]);
    gl.uniform4f(u.u_wind, -Math.sin(windFrom) * windPush, Math.cos(windFrom) * windPush,
      range ? (range[0] - this._timeBase) / 1000 : -3e38,
      range ? (range[1] - this._timeBase) / 1000 : 3e38);
    gl.uniform3fv(u.u_cEmber, parseColor(c.ember));
    gl.uniform3fv(u.u_cBase, parseColor(c.base));
    gl.uniform3fv(u.u_cMid, parseColor(c.mid));
    gl.uniform3fv(u.u_cTip, parseColor(c.tip));
    gl.uniform3fv(u.u_cPuff, parseColor(c.puff));
    gl.uniform3fv(u.u_cPuffEnd, parseColor(c.puffEnd));
    gl.uniform1f(u.u_opacity, clamp(o.opacity, 0, 1));

    if (mesh.vao) this._bindVAO(mesh.vao);
    else this._bindMesh(gl, mesh);
    gl.bindBuffer(gl.ARRAY_BUFFER, this._instanceBuffer);

    const datum = relativeZ && map.transform ? map.transform.elevation || 0 : 0;
    const stride = INSTANCE_FLOATS * 4;
    const m = matrix, m32 = this._m32;
    let copy = NaN;
    for (let r = 0; r < runs.length; r += 3) {
      if (runs[r] !== copy) {
        copy = runs[r];
        // Re-centre the matrix on the camera in float64. The float32 part of the
        // camera offset goes to the shader; its rounding error stays in here.
        const ox32 = Math.fround(cx - copy - this._origin[0]);
        const oy32 = Math.fround(cy - this._origin[1]);
        const tx = this._origin[0] + ox32 + copy, ty = this._origin[1] + oy32;
        for (let i = 0; i < 12; i++) m32[i] = m[i];
        for (let i = 0; i < 4; i++) m32[12 + i] = m[i] * tx + m[4 + i] * ty + m[12 + i];
        gl.uniformMatrix4fv(u.u_matrix, false, m32);
        gl.uniform4f(u.u_cam, ox32, oy32, datum, mercPerMeter(center.lat));
      }
      const offset = runs[r + 1] * stride;
      gl.vertexAttribPointer(3, 4, gl.FLOAT, false, stride, offset);
      gl.vertexAttribPointer(4, 4, gl.FLOAT, false, stride, offset + 16);
      gl.vertexAttribPointer(5, 1, gl.FLOAT, false, stride, offset + 32);
      this._drawInstanced(mesh.indices.length, runs[r + 2]);
    }

    if (mesh.vao) this._bindVAO(null);
    else for (let i = 3; i < 6; i++) { this._divisor(i, 0); gl.disableVertexAttribArray(i); }

    this._stats.lod = lod;
    this._stats.vertices = visible * mesh.vertexCount;
    this._stats.drawCalls = runs.length / 3;
    if (animating || this._pass) this._repaint();
  }

  // ---- internals ----------------------------------------------------------

  _initGL(gl) {
    const gl2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
    const inst = gl2 ? null : gl.getExtension('ANGLE_instanced_arrays');
    const vaoExt = gl2 ? null : gl.getExtension('OES_vertex_array_object');
    if (!gl2 && !inst) {
      this._unsupported = true;
      console.warn('FireLayer: this device cannot draw instanced geometry, so flames are disabled.');
      return;
    }
    this._divisor = gl2 ? (i, d) => gl.vertexAttribDivisor(i, d) : (i, d) => inst.vertexAttribDivisorANGLE(i, d);
    this._drawInstanced = gl2
      ? (n, count) => gl.drawElementsInstanced(gl.TRIANGLES, n, gl.UNSIGNED_SHORT, 0, count)
      : (n, count) => inst.drawElementsInstancedANGLE(gl.TRIANGLES, n, gl.UNSIGNED_SHORT, 0, count);
    this._createVAO = gl2 ? () => gl.createVertexArray() : vaoExt ? () => vaoExt.createVertexArrayOES() : () => null;
    this._bindVAO = gl2 ? (v) => gl.bindVertexArray(v) : vaoExt ? (v) => vaoExt.bindVertexArrayOES(v) : () => {};
    this._deleteVAO = gl2 ? (v) => gl.deleteVertexArray(v) : vaoExt ? (v) => vaoExt.deleteVertexArrayOES(v) : () => {};

    const compile = (type, source) => {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error('FireLayer shader: ' + gl.getShaderInfoLog(shader));
      return shader;
    };
    const program = gl.createProgram();
    const vs = compile(gl.VERTEX_SHADER, VERTEX_SHADER);
    const fs = compile(gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    ATTRIBUTES.forEach((name, i) => gl.bindAttribLocation(program, i, name));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('FireLayer program: ' + gl.getProgramInfoLog(program));
    gl.deleteShader(vs);
    gl.deleteShader(fs);

    this._uniforms = {};
    for (const name of UNIFORMS) this._uniforms[name] = gl.getUniformLocation(program, name);

    this._bindVAO(null);
    this._instanceBuffer = gl.createBuffer();
    this._lods = null;
    this._meshKey = '';

    this._program = program;
    this._dataDirty = true;
  }

  // (Re)build the four quality levels whenever an option that changes the mesh itself does.
  _syncMeshes(gl) {
    const o = this.options;
    const key = [o.spikes, o.sides, o.sparks].map(Math.round).join('/');
    if (key === this._meshKey) return;
    this._meshKey = key;
    this._bindVAO(null);
    this._disposeMeshes(gl);
    this._lods = [0, 1, 2, 3].map((level) => {
      const mesh = buildFlameMesh(level, o);
      mesh.vertexBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, mesh.vertexBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, mesh.vertices, gl.STATIC_DRAW);
      mesh.indexBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.indexBuffer);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
      mesh.vao = this._createVAO();
      if (mesh.vao) {
        this._bindVAO(mesh.vao);
        this._bindMesh(gl, mesh);
        this._bindVAO(null);
      }
      return mesh;
    });
  }

  _disposeMeshes(gl) {
    for (const mesh of this._lods || []) {
      gl.deleteBuffer(mesh.vertexBuffer);
      gl.deleteBuffer(mesh.indexBuffer);
      if (mesh.vao) this._deleteVAO(mesh.vao);
    }
    this._lods = null;
  }

  _bindMesh(gl, mesh) {
    const stride = VERTEX_FLOATS * 4;
    gl.bindBuffer(gl.ARRAY_BUFFER, mesh.vertexBuffer);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.indexBuffer);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 4, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, stride, 16);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 4, gl.FLOAT, false, stride, 32);
    for (let i = 0; i < 3; i++) this._divisor(i, 0);
    for (let i = 3; i < 6; i++) { gl.enableVertexAttribArray(i); this._divisor(i, 1); }
  }

  // Send instance data to the GPU: everything after new data, otherwise just
  // the span whose elevations changed.
  _upload(gl) {
    if (!this._instances) return;
    if (this._dataDirty) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this._instanceBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, this._instances, gl.STATIC_DRAW);
    } else if (this._subHi >= this._subLo) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this._instanceBuffer);
      gl.bufferSubData(gl.ARRAY_BUFFER, this._subLo * INSTANCE_FLOATS * 4,
        this._instances.subarray(this._subLo * INSTANCE_FLOATS, (this._subHi + 1) * INSTANCE_FLOATS));
    }
    this._dataDirty = false;
    this._subLo = Infinity;
    this._subHi = -1;
  }

  // Keep flames standing on 3D terrain. Elevations are read for the flames in
  // view only, a slice per frame, whenever the view or the terrain changes.
  _followTerrain() {
    const map = this.map;
    const terrain = this.options.followTerrain && map.getTerrain && map.getTerrain() ? map.terrain || true : null;
    const inst = this._instances, fixed = this._fixedAltitude;

    if (!terrain) {
      if (this._elevated) { // terrain was switched off: back to the ground plane
        for (let k = 0; k < this._count; k++) if (!fixed[k]) inst[k * INSTANCE_FLOATS + 2] = 0;
        this._elevated = false;
        this._dataDirty = true;
      }
      this._terrainDirty = false;
      this._pass = null;
      return;
    }

    if (this._terrainDirty) {
      this._terrainDirty = false;
      this._pass = { runs: this._runs.slice(), r: 0, i: 0, budget: this._terrainEager ? Infinity : TERRAIN_STEP };
      this._terrainEager = false;
    }
    const pass = this._pass;
    if (!pass) return;

    // terrain.getElevationForLngLatZoom is the per-point lookup behind
    // map.queryTerrainElevation. The public method re-derives the covering
    // tiles on every call in some MapLibre versions, far too slow in bulk.
    const direct = typeof terrain.getElevationForLngLatZoom === 'function';
    const tiles = terrain.tileManager || terrain.sourceCache;
    const maxZoom = tiles && isFinite(tiles.maxzoom) ? tiles.maxzoom : 14;
    const tileZoom = Math.min(Math.floor(map.getZoom()), maxZoom);
    const datum = this._relativeZ && map.transform ? map.transform.elevation || 0 : 0;
    const probe = this._probe, lngLat = this._lngLat;

    let left = pass.budget;
    while (pass.r < pass.runs.length && left > 0) {
      const first = pass.runs[pass.r + 1], count = pass.runs[pass.r + 2];
      while (pass.i < count && left > 0) {
        const k = first + pass.i++;
        if (k >= this._count || fixed[k]) continue;
        left--;
        probe.lng = lngLat[k * 2];
        probe.lat = lngLat[k * 2 + 1];
        const e = direct
          ? terrain.getElevationForLngLatZoom(probe, tileZoom)
          : (map.queryTerrainElevation([probe.lng, probe.lat]) || 0) + datum;
        const j = k * INSTANCE_FLOATS + 2;
        if (Math.abs(inst[j] - e) > 0.25) {
          inst[j] = e;
          if (k < this._subLo) this._subLo = k;
          if (k > this._subHi) this._subHi = k;
        }
      }
      if (pass.i >= count) { pass.r += 3; pass.i = 0; }
    }
    if (pass.r >= pass.runs.length) this._pass = null;
    this._elevated = true;
  }

  _repaint() {
    if (this.map) this.map.triggerRepaint();
  }
}

export default FireLayer;
