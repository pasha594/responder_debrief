/** Site-wide disclaimer + sources link, rendered at the foot of every page. */
import { HREF_SOURCES } from '../app/router';

export function DisclaimerFooter() {
  const onSources = typeof window !== 'undefined'
    && window.location.pathname.endsWith('/sources');
  return (
    <footer className="rd-site-disclaimer">
      Incibrief is for information purposes only. It is not a replacement for
      official government sources. It is currently in development and makes no
      guarantees about data accuracy or uptime.
      {!onSources && (
        <>
          {' '}
          <a href={HREF_SOURCES} className="rd-sources-footlink">
            Sources
          </a>
        </>
      )}
    </footer>
  );
}
