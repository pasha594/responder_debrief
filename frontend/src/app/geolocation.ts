/**
 * Browser geolocation, thin and dependency-free. Requires a secure context
 * (we're HTTPS); the browser shows its own permission prompt on first use.
 */

export type LonLat = [number, number];

const OPTS: PositionOptions = {
  enableHighAccuracy: true,
  timeout: 12_000,
  maximumAge: 15_000,
};

export function geolocationAvailable(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.geolocation;
}

/** One-shot fix. Rejects on denial, timeout, or unavailability. */
export function locateOnce(): Promise<{ coords: LonLat; accuracy: number }> {
  return new Promise((resolve, reject) => {
    if (!geolocationAvailable()) {
      reject(new Error('geolocation unavailable'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        resolve({
          coords: [pos.coords.longitude, pos.coords.latitude],
          accuracy: pos.coords.accuracy,
        }),
      (err) => reject(new Error(err.message)),
      OPTS,
    );
  });
}

/** Continuous fixes until the returned stop function is called. */
export function watchLocation(
  onFix: (fix: { coords: LonLat; accuracy: number }) => void,
  onError: (message: string) => void,
): () => void {
  if (!geolocationAvailable()) {
    onError('geolocation unavailable');
    return () => undefined;
  }
  const id = navigator.geolocation.watchPosition(
    (pos) =>
      onFix({
        coords: [pos.coords.longitude, pos.coords.latitude],
        accuracy: pos.coords.accuracy,
      }),
    (err) => onError(err.message),
    OPTS,
  );
  return () => navigator.geolocation.clearWatch(id);
}
