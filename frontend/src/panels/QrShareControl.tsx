/**
 * Entry points to QR sharing (QrDialog):
 *   - QrShareControl: a round button beside 3D on the fire map — show this
 *     view as a code, or scan one;
 *   - ScanCodeButton: the fire directory's way in — scan only.
 */
import { useCallback, useState } from 'react';
import { QrDialog } from './QrDialog';

function QrIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
      <path d="M3 3h8v8H3V3zm2 2v4h4V5H5zm8-2h8v8h-8V3zm2 2v4h4V5h-4zM3 13h8v8H3v-8zm2 2v4h4v-4H5zm8-2h2v2h-2v-2zm2 2h2v2h-2v-2zm2-2h2v2h-2v-2zm2 2h2v2h-2v-2zm-6 2h2v2h-2v-2zm4 0h2v2h-2v-2zm-2 2h2v2h-2v-2zm4 0h2v2h-2v-2z" />
    </svg>
  );
}

export function QrShareControl() {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  return (
    <>
      <button
        type="button"
        className={`rd-3d-btn rd-qr-btn${open ? ' rd-3d-btn--on' : ''}`}
        title="Share offline with a QR code, or scan one"
        aria-label="Share offline (QR code)"
        onClick={() => setOpen(true)}
      >
        <QrIcon />
      </button>
      {open && <QrDialog initial="show" canShow onClose={close} />}
    </>
  );
}

export function ScanCodeButton() {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  return (
    <>
      <button
        type="button"
        className="rd-mini-btn rd-qr-scan-btn"
        title="Scan a share code from another phone"
        onClick={() => setOpen(true)}
      >
        <QrIcon />
        <span>Scan code</span>
      </button>
      {open && <QrDialog initial="scan" canShow={false} onClose={close} />}
    </>
  );
}
