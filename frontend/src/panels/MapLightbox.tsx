/**
 * Full-screen preview for a map sheet that CANNOT be draped on the map.
 *
 * A non-georeferenced sheet (a QR sheet, an ungridded briefing page) has no
 * projection, so the only honest thing to offer is the page itself. This is
 * that page: the worker's preview raster, big, with a route to the PDF.
 *
 * Portalled to <body> so it clears the sidebar and the timeline rather than
 * being clipped inside the scrolling tab.
 */
import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { dataUrl } from '../api/catalogs';
import type { IncidentMapEntry } from '../api/types';

const FOCUSABLE = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** "Operations Map — 2026-08-17 (day)" for the title bar and the aria label. */
export function lightboxTitle(entry: IncidentMapEntry): string {
  let t = entry.product_label;
  if (entry.op_date) t += ` — ${entry.op_date}`;
  if (entry.period) t += ` (${entry.period})`;
  return t;
}

export function MapLightbox({
  entry,
  onClose,
}: {
  entry: IncidentMapEntry;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const restoreRef = useRef<Element | null>(null);
  const title = lightboxTitle(entry);
  const pdfHref = dataUrl(entry.pdf_url) + '?v=' + entry.rev;

  // Focus the close button on open; hand focus back to the trigger on close.
  useEffect(() => {
    restoreRef.current = document.activeElement;
    closeRef.current?.focus();
    return () => {
      const el = restoreRef.current;
      if (el instanceof HTMLElement && document.contains(el)) el.focus();
    };
  }, []);

  // Escape listens on the document: the dialog stays dismissable even if
  // focus wandered out of it (browser chrome, a click on the backdrop).
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  /** Minimal trap: Tab cycles within the dialog's own controls. */
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab') return;
    const root = dialogRef.current;
    if (!root) return;
    const nodes = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (nodes.length === 0) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || !root.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !root.contains(active))) {
      e.preventDefault();
      first.focus();
    }
  };

  return createPortal(
    <div
      className="rd-lightbox"
      onMouseDown={(e) => {
        // Backdrop only — a drag that started on the image must not close.
        if (e.target !== e.currentTarget) return;
        // Suppress the browser's own mousedown focus, which would otherwise
        // land on <body> AFTER we hand focus back to the trigger.
        e.preventDefault();
        onClose();
      }}
    >
      <div
        className="rd-lightbox-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={dialogRef}
        onKeyDown={onKeyDown}
      >
        <div className="rd-lightbox-bar">
          <span className="rd-lightbox-title">{title}</span>
          <a
            className="rd-pdf-pill"
            href={pdfHref}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open PDF
          </a>
          <button
            type="button"
            className="rd-lightbox-x"
            aria-label="Close preview"
            ref={closeRef}
            onClick={onClose}
          >
            ✕
          </button>
        </div>
        <div className="rd-lightbox-body">
          {entry.preview_url ? (
            <img className="rd-lightbox-img" src={dataUrl(entry.preview_url)} alt={title} />
          ) : (
            <div className="rd-lightbox-empty">
              No preview available — open the PDF to read this sheet.
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
