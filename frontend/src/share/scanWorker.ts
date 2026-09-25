/**
 * QR decoding off the main thread: zxing-wasm (zxing-cpp compiled to
 * WebAssembly — iOS Safari has no built-in BarcodeDetector) reads one camera
 * frame per message.
 *
 * The .wasm ships with the app: Vite emits it into /assets, which the service
 * worker precaches, so scanning works offline. (zxing-wasm's default would
 * fetch it from a CDN.)
 */
import { prepareZXingModule, readBarcodes } from 'zxing-wasm/reader';
import wasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url';

export interface ScanRequest {
  id: number;
  width: number;
  height: number;
  data: ArrayBuffer;
}

export interface ScanReply {
  id: number;
  texts: string[];
  error?: string;
}

prepareZXingModule({
  overrides: {
    locateFile: (path: string, prefix: string) => (path.endsWith('.wasm') ? wasmUrl : prefix + path),
  },
});

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<ScanRequest>) => void) | null;
  postMessage(reply: ScanReply): void;
};

scope.onmessage = async (e) => {
  const { id, width, height, data } = e.data;
  try {
    const found = await readBarcodes(
      { data: new Uint8ClampedArray(data), width, height } as unknown as ImageData,
      // Our codes are always dark on light: skip the inverted pass.
      { formats: ['QRCode'], tryInvert: false, maxNumberOfSymbols: 1 },
    );
    scope.postMessage({ id, texts: found.filter((r) => r.isValid).map((r) => r.text) });
  } catch (err) {
    scope.postMessage({ id, texts: [], error: String(err) });
  }
};
