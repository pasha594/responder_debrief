/** Site-wide disclaimer + sources and release-notes links, rendered at the foot of every page. */
import { HREF_RELEASE_NOTES, HREF_SOURCES, parseLocation } from '../app/router';

export function DisclaimerFooter() {
  const page = typeof window !== 'undefined' ? parseLocation().name : null;
  return (
    <footer className="rd-site-disclaimer">
      Incibrief is for informational purposes only. It is not a replacement for
      official government sources. It is currently in development and makes no
      guarantees about data accuracy or uptime.
      {page !== 'sources' && (
        <>
          {' '}
          <a href={HREF_SOURCES} className="rd-sources-footlink">
            Sources
          </a>
        </>
      )}
      {page !== 'release_notes' && (
        <>
          {' '}
          <a href={HREF_RELEASE_NOTES} className="rd-sources-footlink">
            Release notes
          </a>
        </>
      )}
    </footer>
  );
}
