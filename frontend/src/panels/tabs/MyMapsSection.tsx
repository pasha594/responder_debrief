/**
 * "My maps": georeferenced PDFs the user adds from their own device, listed
 * at the top of every fire's Maps tab (one list for all fires — a map is
 * the user's, not the fire's). Each row behaves like an overlayable
 * incident sheet: show it (one overlay at a time, sharing the sheet opacity
 * slider), zoom to it, open the PDF, or remove it from the device.
 *
 * The PDF never leaves the device, so the section carries `ph-no-capture`:
 * file names must not reach analytics autocapture or session replay. All
 * import work happens in src/userMaps/ (session.ts); this file only renders
 * the store's `userMaps` slice and calls the session's actions.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type React from 'react';
import type { Map as MlMap } from 'maplibre-gl';
import { useMap } from '../../map/MapRoot';
import { useStore } from '../../state/store';
import { formatBytes, formatDay } from '../../utils/format';
import {
  addUserMapFile,
  cancelUserMapImport,
  deleteUserMap,
  dismissUserMapNotice,
  onUserMapAdded,
  retryCrashedImport,
} from '../../userMaps/session';
import { readSource, readThumb, sortUserMaps } from '../../userMaps/storage';
import type {
  Box,
  ImportProgress,
  UserMapMeta,
  UserMapsState,
} from '../../userMaps/types';

// ---------- Pure helpers (exported for tests and reuse) ----------

/** The import status line (read out by the polite live region). */
export function importStatusText(p: ImportProgress): string {
  switch (p.stage) {
    case 'reading':
      return `Reading ${p.fileName}…`;
    case 'saving':
      return 'Saving…';
    case 'locating':
      return 'Finding map coordinates…';
    case 'drawing':
      return p.page != null && p.pages != null
        ? `Drawing page ${p.page} of ${p.pages}…`
        : 'Drawing…';
    case 'finishing':
      return 'Finishing…';
  }
}

/** What the success announcement compares, render to render. */
export interface ImportWatch {
  importing: boolean;
  shownId: string | null;
}

/**
 * The live region's line for a finished import, or null. A success clears
 * the progress card and shows the new map in the same update; a cancel
 * shows nothing new, and a failure or "already added" reads out its own
 * notice — without this the card would just vanish in silence.
 */
export function addedAnnouncement(
  before: ImportWatch,
  now: ImportWatch,
  list: readonly Pick<UserMapMeta, 'id' | 'title'>[],
  hasNotice: boolean,
): string | null {
  if (!before.importing || now.importing || hasNotice) return null;
  if (!now.shownId || now.shownId === before.shownId) return null;
  const meta = list.find((m) => m.id === now.shownId);
  return meta ? `Added ${meta.title}, shown on the map.` : null;
}

/**
 * "Added Oct 16 · 8.3 MB" (viewer-local date). No distance from the fire: a
 * sheet's centre to the fire's origin point reads as nonsense on a map that
 * covers the whole fire ("2 mi from this fire").
 */
export function userMapMetaLine(
  meta: Pick<UserMapMeta, 'addedAt' | 'fileBytes'>,
  nowMs: number = Date.now(),
): string {
  return `Added ${formatDay(meta.addedAt, null, nowMs)} · ${formatBytes(meta.fileBytes)}`;
}

/** True when a drag carries files (not text, a link or an image from the page). */
export function dragHasFiles(types: ArrayLike<string> | null | undefined): boolean {
  if (!types) return false;
  for (let i = 0; i < types.length; i++) if (types[i] === 'Files') return true;
  return false;
}

/**
 * Refuse a file drag that My maps hasn't claimed. A file dropped anywhere
 * else (the map is the natural target) makes the browser open it in this
 * tab: the app is gone, an import mid-draw dies, and a browser that can't
 * keep maps loses them all. React's handlers run first (at the root), so a
 * drag the section took arrives here already defaultPrevented.
 */
export function guardFileDrag(
  e: Pick<DragEvent, 'type' | 'defaultPrevented' | 'dataTransfer' | 'preventDefault'>,
): void {
  if (e.defaultPrevented || !dragHasFiles(e.dataTransfer?.types)) return;
  e.preventDefault(); // never navigate to the file
  if (e.type === 'dragover' && e.dataTransfer) e.dataTransfer.dropEffect = 'none'; // "not here"
}

/** Install guardFileDrag for the whole page (once, at boot); returns the uninstall. */
export function installFileDropGuard(target: EventTarget = window): () => void {
  const onDrag = (e: Event) => guardFileDrag(e as DragEvent);
  target.addEventListener('dragover', onDrag);
  target.addEventListener('drop', onDrag);
  return () => {
    target.removeEventListener('dragover', onDrag);
    target.removeEventListener('drop', onDrag);
  };
}

/**
 * An iPhone/iPad browser tab rather than a Home Screen app. Safari deletes
 * a site's storage after seven days without a visit; Home Screen apps are
 * exempt (and keep a storage of their own). iPadOS reports a Mac UA, so a
 * "MacIntel" with a touch screen counts as an iPad.
 */
export function isIosBrowserTab(
  nav: (Navigator & { standalone?: boolean }) | undefined = typeof navigator === 'undefined'
    ? undefined
    : navigator,
  standaloneDisplay: boolean = typeof matchMedia === 'function' &&
    matchMedia('(display-mode: standalone)').matches,
): boolean {
  if (!nav) return false;
  const ios =
    /iPhone|iPad|iPod/.test(nav.userAgent) ||
    (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1);
  return ios && nav.standalone !== true && !standaloneDisplay;
}

export interface FitPadding {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/**
 * Camera padding for a fit: SearchDirectionsControl's responsive values,
 * widened by what the panel actually covers — the open sidebar on the right
 * (desktop), the bottom sheet at its current snap (phone) — so the map
 * lands in the part of the screen you can see. A sheet pulled up so far
 * that under ~120 px of map would be left fits as if it were down, ready
 * when the sheet comes down (a fit that can't fit is skipped by MapLibre).
 * A sidebar takes the wide values at any width: the desktop layout starts
 * at 768 px, below the 800 px phone/desktop split, and its panel still
 * covers the right of the map there.
 */
export function fitPadding(
  view: { width: number; height: number },
  covered: { right: number; bottom: number } = { right: 0, bottom: 0 },
): FitPadding {
  if (view.width > 800 || covered.right > 0) {
    return { top: 80, bottom: 140, left: 80, right: Math.max(80, covered.right + 60) };
  }
  const top = 60;
  const bottom = Math.max(120, covered.bottom + 16);
  return {
    top,
    bottom: view.height - top - bottom >= 120 ? bottom : 120,
    left: 24,
    right: 24,
  };
}

function prefersReducedMotion(): boolean {
  return (
    typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/** fitPadding for this map, measured against the sidebar or sheet on screen now. */
function userMapPadding(map: MlMap): FitPadding {
  const el = map.getContainer();
  const rect = el.getBoundingClientRect();
  const doc = el.ownerDocument;
  const sidebar = doc.querySelector('.rd-sidebar')?.getBoundingClientRect();
  const sheet = doc.querySelector('.rd-sheet')?.getBoundingClientRect();
  return fitPadding(
    { width: rect.width, height: rect.height },
    {
      right: sidebar ? Math.max(0, rect.right - sidebar.left) : 0,
      bottom: sheet ? Math.max(0, rect.bottom - sheet.top) : 0,
    },
  );
}

const boxBounds = (b: Box): [[number, number], [number, number]] => [
  [b[0], b[1]],
  [b[2], b[3]],
];

/** Frame a user map, clear of the sidebar or sheet; instant under reduced motion. */
export function flyToUserMap(map: MlMap, bounds: Box): void {
  map.fitBounds(boxBounds(bounds), {
    padding: userMapPadding(map),
    duration: prefersReducedMotion() ? 0 : 800,
  });
}

/**
 * True when the view already shows part of the sheet at least as close as
 * a full-sheet fit: the user is reading it, so showing it again leaves the
 * camera alone. A sheet off screen, or a speck seen from far out, is not.
 */
export function alreadyOnUserMap(
  map: MlMap,
  b: Box,
  padding: FitPadding = userMapPadding(map),
): boolean {
  const v = map.getBounds();
  const overlaps =
    v.getWest() < b[2] && v.getEast() > b[0] && v.getSouth() < b[3] && v.getNorth() > b[1];
  if (!overlaps) return false;
  const fit = map.cameraForBounds(boxBounds(b), { padding });
  return fit?.zoom != null && map.getZoom() >= fit.zoom;
}

/**
 * Fly to each map the moment its import finishes (the session has already
 * shown it). FirePanel mounts this rather than the Maps tab, so the camera
 * still goes there when the user switched tabs while the PDF was drawing.
 */
export function useFlyToAddedUserMaps(): void {
  const map = useMap();
  useEffect(() => {
    if (!map) return;
    return onUserMapAdded((meta: UserMapMeta) => flyToUserMap(map, meta.bounds));
  }, [map]);
}

// ---------- Components ----------

/** Off screen but read out (the usual "visually hidden"; the app has no class for it). */
const VISUALLY_HIDDEN: React.CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  overflow: 'hidden',
  clipPath: 'inset(50%)',
  whiteSpace: 'nowrap',
};

/**
 * Object URL for a Blob read from device storage, revoked on unmount or
 * when `key` changes (PackImg's lifecycle — safe under StrictMode).
 */
function useStoredObjectUrl(key: string, load: () => Promise<Blob | null>): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    let objectUrl: string | null = null;
    setUrl(null);
    // `load` from the render that changed `key` — what it reads is fixed by key.
    load()
      .then((blob) => {
        if (!alive || !blob) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => {
        // A missing or unreadable file just leaves the fallback in place.
      });
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [key]);
  return url;
}

function UserMapThumb({ meta }: { meta: UserMapMeta }) {
  const url = useStoredObjectUrl(`${meta.id}@${meta.addedAt}`, () =>
    readThumb(meta.docId, meta.page),
  );
  if (!url) {
    return (
      <div className="rd-thumb rd-thumb--fallback" aria-hidden="true">
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
          <rect x="2.5" y="2.5" width="15" height="15" rx="2" stroke="currentColor" />
          <path d="M2.5 13l4-4 4 4 3-3 4 4" stroke="currentColor" fill="none" />
        </svg>
      </div>
    );
  }
  // The title sits right beside it, so the picture adds nothing to read out.
  return <img className="rd-thumb" src={url} alt="" width={56} height={56} />;
}

/** Corner "open PDF" icon: the saved source PDF, at this map's page. */
function OpenSourceLink({ meta }: { meta: UserMapMeta }) {
  const url = useStoredObjectUrl(meta.docId, async () => {
    const src = await readSource(meta.docId);
    if (!src) return null;
    // OPFS files can come back untyped; a typed wrapper (no copy) makes the
    // new tab open the browser's PDF viewer instead of a download.
    return src.type === 'application/pdf' ? src : new Blob([src], { type: 'application/pdf' });
  });
  if (!url) return null;
  return (
    <a
      className="rd-map-open"
      href={meta.pageCount > 1 ? `${url}#page=${meta.page}` : url}
      target="_blank"
      rel="noopener noreferrer"
      title="Open PDF in a new tab"
      aria-label="Open PDF in a new tab"
    >
      <svg width="13" height="13" viewBox="0 0 13 13" aria-hidden="true">
        <path
          d="M5 2H2.5A1.5 1.5 0 0 0 1 3.5v7A1.5 1.5 0 0 0 2.5 12h7A1.5 1.5 0 0 0 11 10.5V8M7.5 1H12v4.5M12 1 6 7"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </a>
  );
}

function UserMapRow({
  meta,
  onRemoved,
}: {
  meta: UserMapMeta;
  /** Takes keyboard focus off this row's Remove button before the row goes. */
  onRemoved: () => void;
}) {
  const map = useMap();
  const active = useStore((s) => s.layers.userMap.id === meta.id);
  const opacity = useStore((s) => s.layers.incidentMap.opacity);
  const actions = useStore((s) => s.actions);

  // Showing a map also takes you there: it may be anywhere, not on this
  // fire. Not when you're already reading it, though — switching it off and
  // on, or against the incident's own sheet, keeps your zoom.
  const show = () => {
    actions.setUserMap(meta.id);
    if (map && !alreadyOnUserMap(map, meta.bounds)) flyToUserMap(map, meta.bounds);
  };
  const onRowClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (active) return;
    if ((e.target as HTMLElement).closest('button, a, input, label')) return;
    show();
  };
  const remove = () => {
    if (!window.confirm(`Remove “${meta.title}” from this device?`)) return;
    void deleteUserMap(meta.id);
    // Now, not after the delete: the focused button unmounts with the row,
    // and a failure is read out by the notice beside where focus lands.
    onRemoved();
  };

  return (
    <div
      className={`rd-map-row${active ? ' rd-map-row--active' : ' rd-map-row--clickable'}`}
      onClick={onRowClick}
      title={active ? undefined : 'Show this map on the map'}
    >
      <UserMapThumb meta={meta} />
      <div className="rd-map-row-body">
        <div className="rd-map-row-title rd-my-maps-title">{meta.title}</div>
        <div className="rd-map-row-meta">{userMapMetaLine(meta)}</div>
        {meta.warnings.includes('approximate_projection') && (
          <div className="rd-my-maps-approx">Position approximate</div>
        )}

        <div className="rd-map-row-actions">
          <button
            type="button"
            className={`rd-toggle-btn${active ? ' rd-toggle-btn--on' : ''}`}
            aria-pressed={active}
            onClick={() => (active ? actions.setUserMap(null) : show())}
          >
            <span className="rd-radio-dot" aria-hidden="true" />
            {active ? 'Shown on map' : 'Show on map'}
          </button>

          {active && (
            <>
              <input
                type="range"
                className="rd-slider"
                min={0}
                max={1}
                step={0.05}
                value={opacity}
                onChange={(e) => actions.setIncidentMapOpacity(Number(e.target.value))}
                aria-label="Overlay opacity"
              />
              <button
                type="button"
                className="rd-mini-btn"
                onClick={() => map && flyToUserMap(map, meta.bounds)}
              >
                Zoom to
              </button>
            </>
          )}

          <button
            type="button"
            className="rd-mini-btn"
            aria-label={`Remove ${meta.title}`}
            onClick={remove}
          >
            Remove
          </button>
        </div>
      </div>

      <OpenSourceLink meta={meta} />
    </div>
  );
}

/**
 * Every button here unmounts the card it sits in, so each hands keyboard
 * focus on through `onDone` (else it falls to <body>).
 */
export function NoticeCard({
  notice,
  onDone,
}: {
  notice: NonNullable<UserMapsState['notice']>;
  onDone: () => void;
}) {
  const dismiss = () => {
    dismissUserMapNotice();
    onDone();
  };
  if (notice.kind === 'crashed') {
    return (
      <div className="rd-my-maps-notice rd-my-maps-notice--error">
        <div className="rd-my-maps-notice-body">
          <p>{notice.text}</p>
          <div className="rd-my-maps-notice-actions">
            <button
              type="button"
              className="rd-mini-btn"
              onClick={() => {
                void retryCrashedImport();
                onDone();
              }}
            >
              Try again
            </button>
            <button type="button" className="rd-mini-btn" onClick={dismiss}>
              Dismiss
            </button>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className={`rd-my-maps-notice rd-my-maps-notice--${notice.kind}`}>
      <div className="rd-my-maps-notice-body">
        <p>{notice.text}</p>
      </div>
      <button
        type="button"
        className="rd-my-maps-dismiss"
        aria-label="Dismiss"
        title="Dismiss"
        onClick={dismiss}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M1 1l8 8M9 1 1 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}

export function MyMapsSection() {
  const { list, loaded, sessionOnly, import: progress, notice } = useStore((s) => s.userMaps);
  const shownId = useStore((s) => s.layers.userMap.id);
  const fileRef = useRef<HTMLInputElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const dragDepth = useRef(0);
  const [dropping, setDropping] = useState(false);
  const importing = progress != null;
  // Cancel, Dismiss, Try again and Remove unmount the button they're on;
  // the Add button always stays (aria-disabled, so focusable mid-import).
  const focusAdd = () => addRef.current?.focus();

  // "Added …" for screen readers when an import succeeds, then cleared.
  const [added, setAdded] = useState<string | null>(null);
  const watched = useRef<ImportWatch>({ importing, shownId });
  useEffect(() => {
    const before = watched.current;
    watched.current = { importing, shownId };
    if (importing) setAdded(null);
    const text = addedAnnouncement(before, { importing, shownId }, list, notice != null);
    if (text) setAdded(text);
  }, [importing, shownId, list, notice]);
  useEffect(() => {
    if (!added) return;
    const t = setTimeout(() => setAdded(null), 5000);
    return () => clearTimeout(t);
  }, [added]);

  // Newest first, a PDF's pages together (the session's list should already
  // be in this order; sorting here keeps the rows stable whatever it does).
  const maps = useMemo(() => sortUserMaps(list), [list]);
  // Evaluated per render: cheap, and display-mode can change if the page is
  // opened from the Home Screen later.
  const iosTab = maps.length > 0 && !sessionOnly && isIosBrowserTab();

  const add = (file: File) => {
    void addUserMapFile(file);
  };

  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Reset so picking the same file again still fires a change.
    e.target.value = '';
    if (file) add(file);
  };

  // Drop target (desktop, iPad): only for file drags. Enter/leave fire for
  // every child crossed, so a depth count decides when the drag left.
  const onDragEnter = (e: React.DragEvent<HTMLElement>) => {
    if (!dragHasFiles(e.dataTransfer?.types)) return;
    e.preventDefault();
    dragDepth.current += 1;
    if (!importing) setDropping(true);
  };
  const onDragOver = (e: React.DragEvent<HTMLElement>) => {
    if (!dragHasFiles(e.dataTransfer?.types)) return;
    // Always claim the drag, so a drop here never navigates to the PDF.
    e.preventDefault();
    e.dataTransfer.dropEffect = importing ? 'none' : 'copy';
  };
  const onDragLeave = (e: React.DragEvent<HTMLElement>) => {
    if (!dragHasFiles(e.dataTransfer?.types)) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDropping(false);
  };
  const onDrop = (e: React.DragEvent<HTMLElement>) => {
    if (!dragHasFiles(e.dataTransfer?.types)) return;
    e.preventDefault();
    dragDepth.current = 0;
    setDropping(false);
    const file = e.dataTransfer.files[0];
    if (file && !importing) add(file);
  };

  return (
    <section
      className={`rd-map-group rd-my-maps ph-no-capture${dropping ? ' rd-my-maps--drop' : ''}`}
      aria-labelledby="rd-my-maps-head"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <h3 id="rd-my-maps-head" className="rd-section-title rd-map-date-head">
        <span>My maps</span>
      </h3>

      <div className="rd-my-maps-add">
        {loaded && maps.length === 0 && (
          <p className="rd-my-maps-help">
            Lay your own georeferenced PDF (like an incident map) on the map. It stays on this
            device.
          </p>
        )}
        {/* aria-disabled, not disabled: a disabled button drops keyboard
            focus to the page while the import runs. */}
        <button
          ref={addRef}
          type="button"
          className="rd-offline-btn"
          aria-disabled={importing || undefined}
          onClick={() => {
            if (!importing) fileRef.current?.click();
          }}
        >
          Add PDF map
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/pdf,.pdf"
          className="rd-my-maps-file ph-no-capture"
          tabIndex={-1}
          aria-hidden="true"
          onChange={onPick}
        />
      </div>

      <div className="rd-my-maps-status" aria-live="polite">
        {progress && (
          <div className="rd-offline-card rd-my-maps-progress">
            <div className="rd-offline-row">
              <span>{importStatusText(progress)}</span>
              <button
                type="button"
                className="rd-mini-btn"
                onClick={() => {
                  cancelUserMapImport();
                  focusAdd();
                }}
              >
                Cancel
              </button>
            </div>
            <div className="rd-offline-note">Keep this screen open.</div>
          </div>
        )}
        {notice && <NoticeCard notice={notice} onDone={focusAdd} />}
        {/* Seen as the map appearing; heard through this region. */}
        {added && <span style={VISUALLY_HIDDEN}>{added}</span>}
      </div>

      {maps.map((m) => (
        <UserMapRow key={m.id} meta={m} onRemoved={focusAdd} />
      ))}

      {sessionOnly && (
        <p className="rd-my-maps-note">
          This browser can’t keep maps — they’ll be gone when you close the page.
        </p>
      )}
      {iosTab && (
        <p className="rd-my-maps-note">
          Safari may clear saved maps after a week away. Add Incibrief to your Home Screen to keep
          them.
        </p>
      )}
    </section>
  );
}
