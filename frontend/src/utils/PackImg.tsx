/**
 * An <img> whose bytes arrive via fetch — plain <img src> uses the browser's
 * own loader, which bypasses the offline pack's window.fetch wrapper, so
 * thumbnails would break in the field. Online this still rides the HTTP
 * cache (fetch does); offline the wrapper serves the packed copy.
 */
import { useEffect, useState } from 'react';

export function PackImg({
  src,
  className,
  alt,
  width,
  height,
  fallback = null,
}: {
  src: string;
  className?: string;
  alt: string;
  width?: number;
  height?: number;
  fallback?: React.ReactNode;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    let objectUrl: string | null = null;
    setUrl(null);
    setFailed(false);
    fetch(src)
      .then((r) => (r.ok ? r.blob() : null))
      .then((blob) => {
        if (!alive) return;
        if (!blob) {
          setFailed(true);
          return;
        }
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [src]);

  if (failed || !url) return <>{fallback}</>;
  return <img className={className} src={url} alt={alt} width={width} height={height} />;
}
