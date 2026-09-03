/**
 * PyreCast credit chip — their logo linking back to pyrecast.org, shown over
 * the map whenever the fire-forecast layer is drawn (their one condition for
 * free use of the forecasts). Unlike the LegendBar it also shows on mobile,
 * where legends live inside the tabs.
 */
import { useStore } from '../state/store';
import { useSpreadRunForFire } from './tabs/ForecastTab';
import { PYRECAST_CITATION, PYRECAST_URL, spreadCreditVisible } from '../spread/credit';
import pyrecastLogo from '../assets/pyrecast-logo.svg';

export function PyrecastCredit() {
  const spreadVisible = useStore((s) => s.layers.spread.visible);
  const view = useStore((s) => s.view);
  const incidentChip = useStore((s) => !!s.layers.incidentMap.mapId || !!s.layers.incidentMap.series);
  const fireMode = view.mode === 'fire';
  const corneaId = fireMode ? view.corneaId : null;
  const run = useSpreadRunForFire(corneaId);

  if (!spreadCreditVisible({ fireMode, spreadVisible, hasRun: !!run })) return null;

  return (
    <a
      className={`rd-credit${incidentChip ? ' rd-credit--lifted' : ''}`}
      href={PYRECAST_URL}
      target="_blank"
      rel="noopener noreferrer"
      title={PYRECAST_CITATION}
      aria-label={`${PYRECAST_CITATION} — opens pyrecast.org`}
    >
      <span className="rd-credit-label">Fire forecast by</span>
      <img className="rd-credit-logo" src={pyrecastLogo} alt="PyreCast" />
    </a>
  );
}
