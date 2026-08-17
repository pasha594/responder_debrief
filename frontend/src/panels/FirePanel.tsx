/** Selected-fire panel: header, badge, stats strip, tab bar + active tab. */
import { useMemo } from 'react';
import { useFire, useMasterCatalog } from '../api/queries';
import { useStore, type AppState } from '../state/store';
import { formatAcres, formatPct } from '../utils/format';
import { OverviewTab } from './tabs/OverviewTab';
import { ForecastTab, useSpreadRunForFire } from './tabs/ForecastTab';
import { WeatherTab } from './tabs/WeatherTab';
import { IncidentMapsTab } from './tabs/IncidentMapsTab';

type Tab = AppState['ui']['sidebarTab'];

const TABS: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'forecast', label: 'Forecast' },
  { id: 'weather', label: 'Weather' },
  { id: 'maps', label: 'Maps' },
];

export function FirePanel({ corneaId }: { corneaId: string }) {
  const { data: fire } = useFire(corneaId);
  const { data: catalog } = useMasterCatalog();
  const run = useSpreadRunForFire(corneaId);
  const tab = useStore((s) => s.ui.sidebarTab);
  const actions = useStore((s) => s.actions);

  const catalogFire = useMemo(
    () => catalog?.fires.find((f) => f.cornea_id === corneaId) ?? null,
    [catalog, corneaId],
  );

  const forecastDisabled = !catalogFire?.has_spread_forecast && !run;
  const mapsDisabled = !catalogFire?.incident_manifest;
  const disabled: Record<Tab, boolean> = {
    overview: false,
    forecast: forecastDisabled,
    weather: false,
    maps: mapsDisabled,
  };
  const activeTab: Tab = disabled[tab] ? 'overview' : tab;

  const contained = fire?.containment === 100;

  return (
    <div className="rd-panel">
      <header className="rd-fp-header">
        <button type="button" className="rd-back" onClick={() => actions.backToNational()}>
          ← All fires
        </button>
        <div className="rd-fp-titlerow">
          <h2 className="rd-fp-name">{fire?.post_title ?? '…'}</h2>
          {fire &&
            (contained ? (
              <span className="rd-badge rd-badge-contained">Contained</span>
            ) : fire.active ? (
              <span className="rd-badge rd-badge-active">
                <span className="rd-pulse-dot" aria-hidden="true" />
                Active
              </span>
            ) : null)}
        </div>
        {fire && (
          <div className="rd-fp-state">
            {fire.state_full ?? fire.state}
            {fire.county ? ` • ${fire.county}` : ''}
          </div>
        )}

        <div className="rd-stats-strip">
          <div className="rd-stat">
            <span className="rd-stat-value">{formatAcres(fire?.acres)}</span>
            <span className="rd-stat-label">Size</span>
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
              disabled={disabled[t.id]}
              title={
                t.id === 'forecast' && forecastDisabled
                  ? 'No spread forecast published for this fire'
                  : t.id === 'maps' && mapsDisabled
                    ? 'No incident maps published for this fire'
                    : undefined
              }
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
        {activeTab === 'weather' && <WeatherTab />}
        {activeTab === 'maps' && <IncidentMapsTab corneaId={corneaId} />}
      </div>
    </div>
  );
}
