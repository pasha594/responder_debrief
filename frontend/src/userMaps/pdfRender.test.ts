/**
 * pdfRender's two promises to importMap that need no real pdf.js: a decoder
 * that can't be fetched fails openPdf loudly (pdf.js itself would draw its
 * images white and call it a success), and renderCrop names every budget
 * it tries before drawing it (the crash breadcrumb must hold the one that
 * died). pdf.js and the canvas are stubbed; rendering itself is not tested
 * here.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const page = {
    userUnit: 1,
    getViewport: ({ scale }: { scale: number }) => ({
      rotation: 0,
      transform: [scale, 0, 0, -scale, 0, 0],
      convertToViewportPoint: (x: number, y: number) => [x * scale, y * scale],
    }),
    render: vi.fn(),
    cleanup: vi.fn(),
  };
  const destroy = vi.fn(async () => undefined);
  const getDocument = vi.fn(() => ({
    promise: Promise.resolve({ numPages: 1, getPage: async () => page }),
    destroy,
  }));
  return { page, destroy, getDocument };
});

vi.mock('pdfjs-dist/legacy/build/pdf.min.mjs', () => ({
  getDocument: h.getDocument,
  GlobalWorkerOptions: {},
}));
vi.stubGlobal('location', { href: 'https://example.test/app/' });
// Every canvas comes back without a backing store (as on a phone out of memory).
vi.stubGlobal('document', {
  createElement: () => ({ width: 0, height: 0, getContext: () => null }),
});
const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const { openPdf, probePixelDrawn } = await import('./pdfRender');

beforeEach(() => {
  fetchMock.mockReset();
  h.destroy.mockClear();
});

describe('openPdf', () => {
  it('fetches the JPEG 2000 / JBIG2 decoders up front; a failed fetch fails the open as offline', async () => {
    fetchMock.mockRejectedValue(new TypeError('Load failed'));
    await expect(openPdf(new Uint8Array(8))).rejects.toThrow(/^Failed to fetch .*openjpeg\.wasm|^Failed to fetch .*jbig2\.wasm/);
    expect(h.destroy).toHaveBeenCalled(); // the pdf.js worker doesn't linger

    // A 404 (or an error page) too: anything but the whole wasm body.
    fetchMock.mockResolvedValue({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) });
    await expect(openPdf(new Uint8Array(8))).rejects.toThrow(/^Failed to fetch /);
  });

  it('opens once both decoders are fetched (read to the end, so they are cached)', async () => {
    const bodies: string[] = [];
    fetchMock.mockImplementation(async (url: string) => ({
      ok: true,
      arrayBuffer: async () => {
        bodies.push(url.split('/').pop()!);
        return new ArrayBuffer(4);
      },
    }));
    const opened = await openPdf(new Uint8Array(8));
    expect(opened.numPages).toBe(1);
    expect(bodies.sort()).toEqual(['jbig2.wasm', 'openjpeg.wasm']);
  });
});

describe('renderCrop', () => {
  it('reports each budget of the ladder before trying it', async () => {
    fetchMock.mockResolvedValue({ ok: true, arrayBuffer: async () => new ArrayBuffer(4) });
    const opened = await openPdf(new Uint8Array(8));
    const tried: number[] = [];
    await expect(
      opened.renderCrop(1, [0, 0, 612, 792], 12e6, undefined, (b) => tried.push(b)),
    ).rejects.toMatchObject({ name: 'RenderFailed' });
    expect(tried).toEqual([12e6, 6e6, 3e6, 2e6]);
    expect(h.page.render).not.toHaveBeenCalled(); // no canvas, no draw
  });
});

describe('probePixelDrawn', () => {
  it('accepts the red probe pixel through Safari Private Browsing noise (±3 on every channel)', () => {
    expect(probePixelDrawn([255, 0, 0, 255])).toBe(true);
    for (const n of [-3, -2, -1, 1, 2, 3]) {
      const c = (v: number) => Math.min(255, Math.max(0, v + n));
      expect(probePixelDrawn([c(255), c(0), c(0), c(255)])).toBe(true);
    }
  });

  it('rejects the zeros a canvas without a backing store reads back', () => {
    expect(probePixelDrawn([0, 0, 0, 0])).toBe(false);
    expect(probePixelDrawn([0, 0, 0, 255])).toBe(false); // opaque black: the fill never landed
  });
});
