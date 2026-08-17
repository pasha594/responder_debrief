/**
 * Right-hand panel shell. Desktop (≥768px): fixed-width sidebar with a
 * collapse rail. Mobile: the same content inside the bottom MobileSheet.
 */
import { useEffect, useState } from 'react';
import { useStore } from '../state/store';
import { NationalPanel } from './NationalPanel';
import { FirePanel } from './FirePanel';
import { MobileSheet } from './MobileSheet';
import { IncidentMapChip } from './tabs/IncidentMapsTab';
import './panels.css';

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = () => setMatches(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

function PanelContent() {
  const view = useStore((s) => s.view);
  return view.mode === 'fire' ? <FirePanel corneaId={view.corneaId} /> : <NationalPanel />;
}

function Chevron({ collapsed }: { collapsed: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      aria-hidden="true"
      style={{ transform: collapsed ? 'rotate(180deg)' : undefined }}
    >
      <path d="M5 2.5L9.5 7L5 11.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function Sidebar() {
  const isDesktop = useMediaQuery('(min-width: 768px)');
  const collapsed = useStore((s) => s.ui.sidebarCollapsed);
  const setSidebarCollapsed = useStore((s) => s.actions.setSidebarCollapsed);

  if (!isDesktop) {
    return (
      <>
        <MobileSheet>
          <PanelContent />
        </MobileSheet>
        <IncidentMapChip />
      </>
    );
  }

  return (
    <>
      <aside className={`rd-sidebar${collapsed ? ' rd-sidebar--collapsed' : ''}`}>
        <button
          type="button"
          className="rd-sidebar-collapse"
          aria-label={collapsed ? 'Expand panel' : 'Collapse panel'}
          title={collapsed ? 'Expand panel' : 'Collapse panel'}
          onClick={() => setSidebarCollapsed(!collapsed)}
        >
          <Chevron collapsed={collapsed} />
        </button>
        {!collapsed && (
          <div className="rd-sidebar-content">
            <PanelContent />
          </div>
        )}
      </aside>
      <IncidentMapChip />
    </>
  );
}
