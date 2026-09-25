/**
 * Hidden switch for QR sharing while it is tested on real phones: open any
 * page with `?qr=1` to turn it on for this browser (remembered in
 * localStorage), `?qr=0` to turn it off. Off by default. Share links
 * (`/s#…`) open for everyone — they only exist once someone shares.
 */
const KEY = 'rd-qr';

function read(): boolean {
  try {
    const q = new URLSearchParams(window.location.search).get('qr');
    if (q === '1') localStorage.setItem(KEY, '1');
    if (q === '0') localStorage.removeItem(KEY);
    return localStorage.getItem(KEY) === '1';
  } catch {
    // storage blocked: the URL alone decides, for this page load
    return new URLSearchParams(window.location.search).get('qr') === '1';
  }
}

export const QR_SHARING_ENABLED: boolean = typeof window !== 'undefined' && read();
