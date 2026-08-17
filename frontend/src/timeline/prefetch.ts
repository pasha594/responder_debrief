/**
 * FramePrefetcher — strictly sequential loader for spread-forecast frame
 * images (GeoServer flow control is real: concurrency 1 to gs02). Decoded
 * Images live in an LRU Map so playback/scrubbing swaps are atomic; the
 * browser HTTP cache backs everything else up.
 *
 * `enqueue(urls)` REPLACES the queue — priority is simply the given order
 * (callers pass playhead-forward then backward). Cached and duplicate urls
 * are skipped. The in-flight request is never aborted; the new queue takes
 * effect at the next dequeue.
 */
import { FRAME_CACHE_MAX_ENTRIES } from '../app/config';

export type PrefetchEvent = 'loaded' | 'error';
type Listener = (url: string) => void;

export class FramePrefetcher {
  /** Insertion-ordered Map doubles as the LRU (oldest = first key). */
  private cache = new Map<string, HTMLImageElement>();
  private queue: string[] = [];
  private pumping = false;
  private listeners: Record<PrefetchEvent, Set<Listener>> = {
    loaded: new Set(),
    error: new Set(),
  };

  /**
   * Called once per failed frame (404s from run rotation, network errors).
   * The Timeline wires this to catalog invalidation + a toast, throttled.
   */
  onError: ((url: string) => void) | null = null;

  /** Is this url decoded and ready for an atomic swap? (touches LRU) */
  has(url: string): boolean {
    const img = this.cache.get(url);
    if (!img) return false;
    // touch: re-insert as most recently used
    this.cache.delete(url);
    this.cache.set(url, img);
    return true;
  }

  get(url: string): HTMLImageElement | null {
    return this.cache.get(url) ?? null;
  }

  /** Replace the queue. Dedup, skip already-cached; order = priority. */
  enqueue(urls: string[]): void {
    const seen = new Set<string>();
    const next: string[] = [];
    for (const url of urls) {
      if (seen.has(url) || this.cache.has(url)) continue;
      seen.add(url);
      next.push(url);
    }
    this.queue = next;
    void this.pump();
  }

  clear(): void {
    this.queue = [];
  }

  on(event: PrefetchEvent, cb: Listener): () => void {
    this.listeners[event].add(cb);
    return () => this.listeners[event].delete(cb);
  }

  private emit(event: PrefetchEvent, url: string): void {
    for (const cb of [...this.listeners[event]]) cb(url);
  }

  /** Sequential worker: one uncached GetMap in flight at a time. */
  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      for (;;) {
        const url = this.queue.shift();
        if (url === undefined) break;
        if (this.cache.has(url)) continue;
        try {
          const img = new Image();
          img.decoding = 'async';
          img.src = url;
          await img.decode(); // resolves decoded; rejects on 404/network/decode error
          this.put(url, img);
          this.emit('loaded', url);
        } catch {
          this.onError?.(url);
          this.emit('error', url);
        }
      }
    } finally {
      this.pumping = false;
    }
  }

  private put(url: string, img: HTMLImageElement): void {
    if (this.cache.has(url)) this.cache.delete(url);
    this.cache.set(url, img);
    while (this.cache.size > FRAME_CACHE_MAX_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }
}

/** App-wide singleton — the map's spread layer and the timeline share it. */
export const framePrefetcher = new FramePrefetcher();
