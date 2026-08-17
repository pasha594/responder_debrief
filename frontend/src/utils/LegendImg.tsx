/**
 * Legend image that hides itself until (and unless) its file actually loads —
 * B2 legends appear asynchronously as the worker syncs, and a broken-image
 * icon is worse than no legend.
 */
import { useEffect, useState } from 'react';

export function LegendImg({ src, alt, className }: { src: string; alt: string; className?: string }) {
  const [ok, setOk] = useState<boolean | null>(null);
  useEffect(() => setOk(null), [src]);
  if (ok === false) return null;
  return (
    <img
      src={src}
      alt={alt}
      className={className}
      loading="lazy"
      style={ok ? undefined : { visibility: 'hidden', height: 0 }}
      onLoad={() => setOk(true)}
      onError={() => setOk(false)}
    />
  );
}
