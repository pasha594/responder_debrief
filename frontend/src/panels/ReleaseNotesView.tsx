/** /release_notes — what shipped each day, newest first. Content lives in releaseNotes.ts. */
import { HREF_DIRECTORY } from '../app/router';
import { DisclaimerFooter } from './DisclaimerFooter';
import { RELEASE_NOTES, formatReleaseDate } from './releaseNotes';

export function ReleaseNotesView() {
  return (
    <div className="rd-sources">
      <div className="rd-sources-inner">
      <header className="rd-sources-header">
        <a href={HREF_DIRECTORY} className="rd-back">
          ← All fires
        </a>
        <h1>Release notes</h1>
      </header>
      {RELEASE_NOTES.map((day) => (
        <section key={day.date} className="rd-release-day">
          <h2>
            <time dateTime={day.date}>{formatReleaseDate(day.date)}</time>
          </h2>
          <ul className="rd-release-list">
            {day.notes.map((n) => (
              <li key={n.title} className="rd-release-note">
                <div className="rd-release-title">
                  {n.fix && <span className="rd-release-tag">Fix</span>}
                  {n.title}
                </div>
                <p className="rd-release-summary">{n.summary}</p>
              </li>
            ))}
          </ul>
        </section>
      ))}
      <DisclaimerFooter />
      </div>
    </div>
  );
}
