/**
 * Right-hand panel shell. Desktop (≥768px): fixed-width sidebar with a
 * collapse rail. Mobile: the same content inside the bottom MobileSheet.
 */
import { useStore } from '../state/store';
import { useIsDesktop } from '../utils/useMediaQuery';
import { FirePanel } from './FirePanel';
import { MobileSheet } from './MobileSheet';
import { IncidentMapChip } from './tabs/IncidentMapsTab';
import './panels.css';

/** The sidebar only ever mounts in fire mode (the directory has no map). */
function PanelContent() {
  const view = useStore((s) => s.view);
  return view.mode === 'fire' ? <FirePanel corneaId={view.corneaId} /> : null;
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
  const isDesktop = useIsDesktop();
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
