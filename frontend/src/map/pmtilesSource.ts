/**
 * PMTiles for the trails overlay (npm `pmtiles`, owner-approved).
 *
 * MapLibre 5 has no native PMTiles; the package's Protocol plugs in through
 * maplibregl.addProtocol('pmtiles', …), whose handler runs on the MAIN
 * thread (custom schemes are forwarded out of MapLibre's worker). That
 * matters offline: MapLibre fetches http(s) vector tiles inside its worker,
 * where the OPFS pack wrapper never sees them.
 *
 * Two archives:
 * - online: the national trails.pmtiles, read with HTTP Range through the
 *   stock FetchSource (the fetch wrapper passes Range requests straight to
 *   the network; the S3-endpoint URL is preferred because its 206s carry an
 *   ETag and Chrome HTTP-caches them);
 * - offline: the fire's packed trails.pmtiles extract, read by slicing the
 *   OPFS File directly — no HTTP semantics, no whole-file reads per tile.
 */
import maplibregl from 'maplibre-gl';
import { PMTiles, Protocol, type RangeResponse, type Source } from 'pmtiles';
import { dataUrl } from '../api/catalogs';
import type { RoutingBundle, TrailsPointer } from '../routing/types';

let protocol: Protocol | null = null;

export function ensurePmtilesProtocol(): Protocol {
  if (!protocol) {
    protocol = new Protocol();
    maplibregl.addProtocol('pmtiles', protocol.tile);
  }
  return protocol;
}

/** A pmtiles Source over an OPFS File (Blob.slice → exact byte ranges). */
export class OpfsFileSource implements Source {
  constructor(
    private readonly key: string,
    private readonly file: Blob,
  ) {}

  getKey(): string {
    return this.key;
  }

  async getBytes(offset: number, length: number): Promise<RangeResponse> {
    const data = await this.file.slice(offset, offset + length).arrayBuffer();
    return { data };
  }
}

export interface TrailsArchive {
  /** Recreate the MapLibre source when this changes. */
  key: string;
  kind: 'national' | 'fire';
  url: string;
  attribution: string;
}

export function nationalTrailsArchive(p: TrailsPointer): TrailsArchive {
  const http = p.pmtiles_url_s3 || dataUrl(p.pmtiles);
  ensurePmtilesProtocol();
  return {
    key: `national:${p.build_id}`,
    kind: 'national',
    url: `pmtiles://${http}`,
    attribution: p.attribution || 'Trails: USFS · BLM · NPS',
  };
}

/** Register a packed per-fire extract. `file` is a snapshot: after a pack
 * update the caller must resolve a fresh File (the key then changes). */
export function fireTrailsArchive(bundle: RoutingBundle, file: File): TrailsArchive {
  const key = `rdfire-${bundle.bundle_id}-${file.size}-${file.lastModified}`;
  const p = ensurePmtilesProtocol();
  if (!p.get(key)) p.add(new PMTiles(new OpfsFileSource(key, file)));
  return {
    key,
    kind: 'fire',
    url: `pmtiles://${key}`,
    attribution: 'Trails: USFS · BLM · NPS · © OpenStreetMap contributors',
  };
}
