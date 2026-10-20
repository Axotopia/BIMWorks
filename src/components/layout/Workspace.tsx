import React, { useEffect, useRef } from 'react';
import {
  DockviewReact,
  DockviewReadyEvent,
  IDockviewPanelProps,
} from 'dockview-react';
import { useBimStore, TILE_WINDOWS_EVENT, TAB_VIEWS_EVENT, ZOOM_EXTENTS_EVENT } from '../../store/useBimStore';
import { ProjectBrowser } from '../browser/ProjectBrowser';
import { PropertiesPalette } from '../properties/PropertiesPalette';
import { Viewport3D } from '../viewport/Viewport3D';
import { PlanViewport2D } from '../drafting/PlanViewport2D';
import { SheetCanvas } from '../sheets/SheetCanvas';

// Component wrapper for 3D Viewport in dockview
const ThreeDPanel: React.FC<IDockviewPanelProps> = () => <Viewport3D />;

// Component wrapper for 2D Plan Viewport in dockview
const PlanPanel: React.FC<IDockviewPanelProps> = () => <PlanViewport2D />;

// Component wrapper for Sheet Canvas in dockview
const SheetPanel: React.FC<IDockviewPanelProps> = () => <SheetCanvas />;

// Component wrapper for Project Browser in dockview
const BrowserPanel: React.FC<IDockviewPanelProps> = () => <ProjectBrowser />;

// Component wrapper for Properties in dockview
const PropertiesPanel: React.FC<IDockviewPanelProps> = () => <PropertiesPalette />;

export const Workspace: React.FC = () => {
  const dockviewApiRef = useRef<any>(null);
  const {
    activeViewId,
    activeSheetId,
    setActiveViewId,
    setActiveSheetId,
    views,
    sheets,
  } = useBimStore();

  const components = {
    threeD: ThreeDPanel,
    plan: PlanPanel,
    sheet: SheetPanel,
    browser: BrowserPanel,
    properties: PropertiesPanel,
  };

  const onReady = (event: DockviewReadyEvent) => {
    dockviewApiRef.current = event.api;

    // 1. Add Left Dock: Project Browser
    const browserPanel = event.api.addPanel({
      id: 'panel-browser',
      component: 'browser',
      title: 'Project Browser',
      position: { direction: 'left' },
      initialWidth: 260,
    });

    // 2. Add Center MDI Tabs: 3D View, Plan View, and Sheet Canvas
    const centerPanel = event.api.addPanel({
      id: 'view-3d',
      component: 'threeD',
      title: '{3D}',
      position: { direction: 'right', referencePanel: browserPanel },
    });

    // The plan panels bind to the ids the backend seeds (`view-level-1`,
    // `view-level-2`, `view-roof`). Their *names* follow the loaded model —
    // `sync_plan_views_to_levels` rebinds them to the storeys that actually exist — so
    // the titles here are pre-load fallbacks, replaced by the effect below once `views`
    // arrives. A hardcoded "Floor Plan: Level 1" was wrong for every model but the box.
    event.api.addPanel({
      id: 'view-level-1',
      component: 'plan',
      title: 'Floor Plan',
      position: { referencePanel: centerPanel },
    });

    event.api.addPanel({
      id: 'view-level-2',
      component: 'plan',
      title: 'Floor Plan 2',
      position: { referencePanel: centerPanel },
    });

    // `view-roof`, not `view-roof-plan` — the latter never existed, so this tab bound
    // to no view and rendered the empty-state fallback.
    event.api.addPanel({
      id: 'view-roof',
      component: 'plan',
      title: 'Floor Plan 3',
      position: { referencePanel: centerPanel },
    });

    event.api.addPanel({
      id: 'sheet-a101',
      component: 'sheet',
      title: 'A101 - FLOOR PLAN & SECTIONS',
      position: { referencePanel: centerPanel },
    });

    // Default to {3D} view active
    centerPanel.api.setActive();

    // 3. Add Right Dock: Properties Palette
    event.api.addPanel({
      id: 'panel-properties',
      component: 'properties',
      title: 'Properties',
      position: { direction: 'right' },
      initialWidth: 290,
    });

    // Listen to tab selection changes to sync with global BIM store
    event.api.onDidActivePanelChange((e) => {
      const id = e.panel?.id;
      if (!id) return;
      if (id.startsWith('view-')) {
        setActiveViewId(id);
      } else if (id.startsWith('sheet-')) {
        setActiveSheetId(id);
      }
    });
  };

  // Retitle the seeded plan tabs once the model's views arrive, so they name the storeys
  // the app actually loaded (`Floor Plan: FP1.GARAGE`) instead of a hardcoded
  // "Floor Plan: Level 1" that only ever described the built-in box.
  useEffect(() => {
    const api = dockviewApiRef.current;
    if (!api || !views.length) return;
    // Look each seeded panel up by id. Positional indexing does not work: the plan
    // views are not in elevation order in the payload (the imported model's extra
    // storeys are appended), so plans[2] is not `view-roof`.
    ['view-level-1', 'view-level-2', 'view-roof'].forEach((panelId) => {
      const panel = api.getPanel?.(panelId);
      const view = views.find((v) => v.id === panelId);
      if (panel && view) panel.setTitle(view.name);
    });
  }, [views]);

  // When activeViewId changes externally (e.g. from Project Browser), activate tab in dockview
  useEffect(() => {
    if (dockviewApiRef.current && activeViewId) {
      const panel = dockviewApiRef.current.getPanel(activeViewId);
      if (panel) {
        panel.api.setActive();
      } else {
        const view = views.find((v) => v.id === activeViewId);
        if (view) {
          const comp = view.type === '3d' ? 'threeD' : 'plan';
          const centerPanel = dockviewApiRef.current.getPanel('view-3d');
          dockviewApiRef.current.addPanel({
            id: view.id,
            component: comp,
            title: view.name,
            position: centerPanel ? { referencePanel: centerPanel } : undefined,
          });
        }
      }
    }
  }, [activeViewId, views]);

  useEffect(() => {
    if (dockviewApiRef.current && activeSheetId) {
      const panel = dockviewApiRef.current.getPanel(activeSheetId);
      if (panel) {
        panel.api.setActive();
      }
    }
  }, [activeSheetId]);

  useEffect(() => {
    const handleTile = () => {
      const api = dockviewApiRef.current;
      if (!api) return;
      const threeDPanel = api.getPanel('view-3d');
      // Find the active 2D view or sheet, or fallback to view-level-1
      const active2dId =
        activeViewId && activeViewId !== 'view-3d'
          ? activeViewId
          : activeSheetId || 'view-level-1';
      const secondPanel = api.getPanel(active2dId) || api.getPanel('view-level-1');
      if (secondPanel && threeDPanel) {
        secondPanel.api.moveTo({
          direction: 'right',
          referencePanel: threeDPanel,
        });
        setTimeout(() => {
          window.dispatchEvent(new CustomEvent(ZOOM_EXTENTS_EVENT));
        }, 100);
      }
    };

    const handleTabViews = () => {
      const api = dockviewApiRef.current;
      if (!api) return;
      const threeDPanel = api.getPanel('view-3d');
      if (!threeDPanel) return;
      // Move open plan and sheet panels back into the central tab group
      const allPanelIds = ['view-level-1', 'view-level-2', 'view-roof', 'sheet-a101', 'sheet-a201'];
      if (activeViewId && !allPanelIds.includes(activeViewId)) {
        allPanelIds.push(activeViewId);
      }
      allPanelIds.forEach((pId) => {
        const p = api.getPanel(pId);
        if (p && p !== threeDPanel) {
          p.api.moveTo({
            referencePanel: threeDPanel,
          });
        }
      });
      setTimeout(() => {
        window.dispatchEvent(new CustomEvent(ZOOM_EXTENTS_EVENT));
      }, 100);
    };

    window.addEventListener(TILE_WINDOWS_EVENT, handleTile);
    window.addEventListener(TAB_VIEWS_EVENT, handleTabViews);
    return () => {
      window.removeEventListener(TILE_WINDOWS_EVENT, handleTile);
      window.removeEventListener(TAB_VIEWS_EVENT, handleTabViews);
    };
  }, [activeViewId, activeSheetId]);

  return (
    <div className="flex-1 w-full h-full overflow-hidden dockview-theme-dark">
      <DockviewReact
        components={components}
        onReady={onReady}
        className="dockview-theme-dark h-full w-full"
      />
    </div>
  );
};
