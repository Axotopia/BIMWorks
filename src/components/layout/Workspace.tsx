import React, { useEffect, useRef } from 'react';
import {
  DockviewReact,
  DockviewReadyEvent,
  IDockviewPanelProps,
} from 'dockview-react';
import { useBimStore } from '../../store/useBimStore';
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

    event.api.addPanel({
      id: 'view-level-1',
      component: 'plan',
      title: 'Floor Plan: Level 1',
      position: { referencePanel: centerPanel },
    });

    event.api.addPanel({
      id: 'view-roof-plan',
      component: 'plan',
      title: 'Roof Plan',
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
