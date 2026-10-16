/** Selected-fire panel: header, badge, stats strip, tab bar + active tab. */
import { DisclaimerFooter } from './DisclaimerFooter';
import { useFire } from '../api/queries';
import { useStore, type AppState } from '../state/store';
import { formatAcresValue, formatPct } from '../utils/format';
import { OverviewTab } from './tabs/OverviewTab';
import { ForecastTab } from './tabs/ForecastTab';
import { IncidentMapsTab } from './tabs/IncidentMapsTab';
import { useFlyToAddedUserMaps } from './tabs/MyMapsSection';
import { DrawTab } from './tabs/DrawTab';

type Tab = AppState['ui']['sidebarTab'];

/** No tab ever disables: Layers hosts the weather section and Maps leads
 * with the user's own PDF maps, so both have content on every fire (each
 * shows its own empty note for the fire's part). */
const TABS: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'forecast', label: 'Layers' },
  { id: 'maps', label: 'Maps' },
  { id: 'draw', label: 'Draw' },
];

export function FirePanel({ corneaId }: { corneaId: string }) {
  const { data: fire } = useFire(corneaId);
  const activeTab = useStore((s) => s.ui.sidebarTab);
  const actions = useStore((s) => s.actions);
  // Mounted here, not in the Maps tab, so a map added while the user looks
  // at another tab still flies into view when it finishes.
  useFlyToAddedUserMaps();

  const contained = fire?.containment === 100;

  return (
    <div className="rd-panel">
      <header className="rd-fp-header">
        <div className="rd-fp-titlerow">
          <h2 className="rd-fp-name">{fire?.post_title ?? '…'}</h2>
          {fire && contained && <span className="rd-badge rd-badge-contained">Contained</span>}
        </div>
        {fire && (
          <div className="rd-fp-state">
            {fire.state_full ?? fire.state}
            {fire.county ? ` • ${fire.county}` : ''}
          </div>
        )}

        <div className="rd-stats-strip">
          <div className="rd-stat">
            <span className="rd-stat-value">{formatAcresValue(fire?.acres)}</span>
            <span className="rd-stat-label">Acres</span>
          </div>
          <div className="rd-stat">
            <span className="rd-stat-value">{formatPct(fire?.containment)}</span>
            <span className="rd-stat-label">Contained</span>
          </div>
          <div className="rd-stat">
            <span className="rd-stat-value">
              {fire?.personnel != null ? fire.personnel.toLocaleString('en-US') : '—'}
            </span>
            <span className="rd-stat-label">Personnel</span>
          </div>
          <div className="rd-stat">
            <span className="rd-stat-value">{fire?.days != null ? fire.days : '—'}</span>
            <span className="rd-stat-label">Days</span>
          </div>
        </div>

        <nav className="rd-tabbar" role="tablist" aria-label="Fire detail tabs">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={activeTab === t.id}
              className={`rd-tab${activeTab === t.id ? ' rd-tab--active' : ''}`}
              onClick={() => actions.setSidebarTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </header>

      <div className="rd-panel-scroll">
        {activeTab === 'overview' && <OverviewTab corneaId={corneaId} />}
        {activeTab === 'forecast' && <ForecastTab corneaId={corneaId} />}
        {activeTab === 'maps' && <IncidentMapsTab corneaId={corneaId} />}
        {activeTab === 'draw' && <DrawTab />}
        <DisclaimerFooter />
      </div>
    </div>
  );
}
