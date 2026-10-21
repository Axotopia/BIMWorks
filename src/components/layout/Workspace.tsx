import React, { useState, useEffect, useRef } from 'react';
import {
  DockviewReact,
  DockviewReadyEvent,
  IDockviewPanelProps,
} from 'dockview-react';
import {
  Columns2,
  Rows2,
  Grid2X2,
  Maximize2,
  Box,
  Layers,
  ChevronLeft,
  ChevronRight,
  Eye,
  Scissors,
  FileSpreadsheet,
} from 'lucide-react';
import { useBimStore, TILE_WINDOWS_EVENT, TAB_VIEWS_EVENT, ZOOM_EXTENTS_EVENT } from '../../store/useBimStore';
import { ProjectBrowser } from '../browser/ProjectBrowser';
import { PropertiesPalette } from '../properties/PropertiesPalette';
import { Viewport3D } from '../viewport/Viewport3D';
import { PlanViewport2D } from '../drafting/PlanViewport2D';
import { SheetCanvas } from '../sheets/SheetCanvas';

// Component wrappers for Dockview MDI
const ThreeDPanel: React.FC<IDockviewPanelProps> = () => <Viewport3D />;
const PlanPanel: React.FC<IDockviewPanelProps> = () => <PlanViewport2D />;
const SheetPanel: React.FC<IDockviewPanelProps> = () => <SheetCanvas />;
const BrowserPanel: React.FC<IDockviewPanelProps> = () => <ProjectBrowser />;
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
    viewLayout,
    setViewLayout,
    cycleViewLayout,
  } = useBimStore();

  const [isBrowserOpen, setIsBrowserOpen] = useState(true);
  const [isPropertiesOpen, setIsPropertiesOpen] = useState(true);
  const [splitRatio, setSplitRatio] = useState(0.5); // 50/50 split
  const isDraggingSplit = useRef(false);

  const activeView = views.find((v) => v.id === activeViewId);
  const isSheetActive = activeView?.type === 'sheet' || activeViewId.startsWith('sheet-');

  // Handle drag resizing between 2D and 3D in Split 2V
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDraggingSplit.current) return;
      const totalWidth = window.innerWidth - (isBrowserOpen ? 260 : 0) - (isPropertiesOpen ? 290 : 0);
      const startX = isBrowserOpen ? 260 : 0;
      const ratio = Math.max(0.15, Math.min(0.85, (e.clientX - startX) / totalWidth));
      setSplitRatio(ratio);
    };

    const handleMouseUp = () => {
      isDraggingSplit.current = false;
      document.body.style.cursor = 'default';
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isBrowserOpen, isPropertiesOpen]);

  // Dockview Components
  const components = {
    threeD: ThreeDPanel,
    plan: PlanPanel,
    sheet: SheetPanel,
    browser: BrowserPanel,
    properties: PropertiesPanel,
  };

  const onReady = (event: DockviewReadyEvent) => {
    dockviewApiRef.current = event.api;

    const browserPanel = event.api.addPanel({
      id: 'panel-browser',
      component: 'browser',
      title: 'Project Browser',
      position: { direction: 'left' },
      initialWidth: 260,
    });

    const centerPanel = event.api.addPanel({
      id: 'view-3d',
      component: 'threeD',
      title: '{3D}',
      position: { direction: 'right', referencePanel: browserPanel },
    });

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

    centerPanel.api.setActive();

    event.api.addPanel({
      id: 'panel-properties',
      component: 'properties',
      title: 'Properties',
      position: { direction: 'right' },
      initialWidth: 290,
    });

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

  // Sync tab titles with model
  useEffect(() => {
    const api = dockviewApiRef.current;
    if (!api || !views.length) return;
    ['view-level-1', 'view-level-2', 'view-roof'].forEach((panelId) => {
      const panel = api.getPanel?.(panelId);
      const view = views.find((v) => v.id === panelId);
      if (panel && view) panel.setTitle(view.name);
    });
  }, [views]);

  // Window events for Tile and Tab
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
      cycleViewLayout();
    };

    const handleTabViews = () => {
      setViewLayout('tabs');
      const api = dockviewApiRef.current;
      if (!api) return;
      const threeDPanel = api.getPanel('view-3d');
      if (!threeDPanel) return;
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
    window.addEventListener('bimworks-tab-windows', handleTabViews);
    return () => {
      window.removeEventListener(TILE_WINDOWS_EVENT, handleTile);
      window.removeEventListener(TAB_VIEWS_EVENT, handleTabViews);
      window.removeEventListener('bimworks-tab-windows', handleTabViews);
    };
  }, [cycleViewLayout, setViewLayout, activeViewId, activeSheetId]);

  // 2D View Switcher items
  const planViews = views.filter((v) => v.type === 'floor_plan');
  const elevViews = views.filter((v) => v.type === 'elevation');
  const secViews = views.filter((v) => v.type === 'section');

  return (
    <div className="flex-1 w-full h-full flex overflow-hidden bg-[#e2e8f0] select-none font-sans relative">
      {/* 1. Left Dock: Project Browser */}
      {isBrowserOpen ? (
        <div className="w-[260px] h-full flex-shrink-0 relative border-r border-[#cbd5e1] shadow-sm z-10 flex flex-col">
          <ProjectBrowser />
          <button
            onClick={() => setIsBrowserOpen(false)}
            className="absolute top-2 right-1.5 p-1 bg-slate-200 hover:bg-slate-300 rounded text-slate-600 transition-colors z-20"
            title="Collapse Project Browser"
          >
            <ChevronLeft size={13} />
          </button>
        </div>
      ) : (
        <button
          onClick={() => setIsBrowserOpen(true)}
          className="w-5 h-full bg-[#f1f5f9] hover:bg-[#e2e8f0] border-r border-[#cbd5e1] flex items-center justify-center text-slate-500 z-10 transition-colors"
          title="Expand Project Browser"
        >
          <ChevronRight size={14} />
        </button>
      )}

      {/* 2. Center Stage (Multi-View Workspace) */}
      <div className="flex-1 h-full flex flex-col min-w-0 min-h-0 bg-[#0f172a] relative overflow-hidden">
        {/* Multi-View Header Bar (View Mode Switcher & 2D View Pills) */}
        <div className="h-8 bg-[#1e293b] border-b border-slate-700/80 px-2.5 flex items-center justify-between text-xs text-slate-200 select-none z-20 flex-shrink-0 shadow-md">
          {/* Left: View Layout Switcher (Split, Quad, 3D, 2D, Tabs) */}
          <div className="flex items-center space-x-1">
            <span className="text-[10px] uppercase font-bold text-slate-400 mr-1.5 tracking-wider">
              Layout:
            </span>

            {/* Split 2V (Plan + 3D) */}
            <button
              onClick={() => setViewLayout('split-2v')}
              className={`flex items-center space-x-1 px-2 py-0.5 rounded text-[11px] font-semibold transition-all ${
                viewLayout === 'split-2v'
                  ? 'bg-sky-600 text-white shadow'
                  : 'bg-slate-800 text-slate-300 hover:bg-slate-700 hover:text-white'
              }`}
              title="Split 2V: 2D Plan & 3D Model Side-by-Side (WT)"
            >
              <Columns2 size={12} />
              <span>Split 2V</span>
            </button>

            {/* Quad 4-View */}
            <button
              onClick={() => setViewLayout('quad')}
              className={`flex items-center space-x-1 px-2 py-0.5 rounded text-[11px] font-semibold transition-all ${
                viewLayout === 'quad'
                  ? 'bg-sky-600 text-white shadow'
                  : 'bg-slate-800 text-slate-300 hover:bg-slate-700 hover:text-white'
              }`}
              title="Quad 4-View: Plan, Elevation, Section, 3D Model (Revit 4-View)"
            >
              <Grid2X2 size={12} />
              <span>Quad 4</span>
            </button>

            {/* Split 2H (Stacked) */}
            <button
              onClick={() => setViewLayout('split-2h')}
              className={`flex items-center space-x-1 px-2 py-0.5 rounded text-[11px] font-semibold transition-all ${
                viewLayout === 'split-2h'
                  ? 'bg-sky-600 text-white shadow'
                  : 'bg-slate-800 text-slate-300 hover:bg-slate-700 hover:text-white'
              }`}
              title="Split 2H: 2D Plan on Top, 3D on Bottom"
            >
              <Rows2 size={12} />
              <span>Stacked</span>
            </button>

            {/* Single 3D */}
            <button
              onClick={() => setViewLayout('single-3d')}
              className={`flex items-center space-x-1 px-2 py-0.5 rounded text-[11px] font-semibold transition-all ${
                viewLayout === 'single-3d'
                  ? 'bg-sky-600 text-white shadow'
                  : 'bg-slate-800 text-slate-300 hover:bg-slate-700 hover:text-white'
              }`}
              title="Full Screen {3D} Perspective Viewport"
            >
              <Box size={12} />
              <span>{'{3D}'}</span>
            </button>

            {/* Single 2D */}
            <button
              onClick={() => setViewLayout('single-2d')}
              className={`flex items-center space-x-1 px-2 py-0.5 rounded text-[11px] font-semibold transition-all ${
                viewLayout === 'single-2d'
                  ? 'bg-sky-600 text-white shadow'
                  : 'bg-slate-800 text-slate-300 hover:bg-slate-700 hover:text-white'
              }`}
              title="Full Screen 2D Plan / Elevation / Section"
            >
              <Layers size={12} />
              <span>2D Only</span>
            </button>

            {/* Dockview Tabs */}
            <button
              onClick={() => setViewLayout('tabs')}
              className={`flex items-center space-x-1 px-2 py-0.5 rounded text-[11px] font-semibold transition-all ${
                viewLayout === 'tabs'
                  ? 'bg-sky-600 text-white shadow'
                  : 'bg-slate-800 text-slate-300 hover:bg-slate-700 hover:text-white'
              }`}
              title="Revit MDI Dockview Tabs (TW)"
            >
              <span>Tabs</span>
            </button>
          </div>

          {/* Right: Quick View Switcher for the 2D Viewport */}
          <div className="flex items-center space-x-1 overflow-x-auto">
            <span className="text-[10px] text-slate-400 uppercase font-semibold mr-1">
              Active 2D:
            </span>

            {/* Plans */}
            {planViews.map((pv) => (
              <button
                key={pv.id}
                onClick={() => setActiveViewId(pv.id)}
                className={`px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${
                  activeViewId === pv.id
                    ? 'bg-sky-500/30 text-sky-300 border border-sky-500/60 font-semibold'
                    : 'bg-slate-800 text-slate-400 hover:text-slate-200'
                }`}
              >
                {pv.name.replace('Floor Plan: ', '')}
              </button>
            ))}

            {/* Section 1 */}
            {secViews.length > 0 && (
              <button
                onClick={() => setActiveViewId(secViews[0].id)}
                className={`flex items-center space-x-1 px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${
                  activeViewId === secViews[0].id
                    ? 'bg-pink-500/30 text-pink-300 border border-pink-500/60 font-semibold'
                    : 'bg-slate-800 text-slate-400 hover:text-slate-200'
                }`}
                title="Section View"
              >
                <Scissors size={10} className="text-pink-400" />
                <span>Section 1</span>
              </button>
            )}

            {/* South Elevation */}
            {elevViews.length > 0 && (
              <button
                onClick={() => setActiveViewId(elevViews[0].id)}
                className={`flex items-center space-x-1 px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${
                  activeViewId === elevViews[0].id
                    ? 'bg-emerald-500/30 text-emerald-300 border border-emerald-500/60 font-semibold'
                    : 'bg-slate-800 text-slate-400 hover:text-slate-200'
                }`}
                title="South Elevation"
              >
                <Eye size={10} className="text-emerald-400" />
                <span>South Elev</span>
              </button>
            )}

            {/* Sheet A101 */}
            {sheets.length > 0 && (
              <button
                onClick={() => {
                  setActiveSheetId(sheets[0].id);
                  setActiveViewId(sheets[0].id);
                }}
                className={`flex items-center space-x-1 px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${
                  isSheetActive
                    ? 'bg-purple-500/30 text-purple-300 border border-purple-500/60 font-semibold'
                    : 'bg-slate-800 text-slate-400 hover:text-slate-200'
                }`}
                title="Sheet A101"
              >
                <FileSpreadsheet size={10} className="text-purple-400" />
                <span>A101</span>
              </button>
            )}

            {/* Zoom Extents (ZE) */}
            <button
              onClick={() => window.dispatchEvent(new CustomEvent(ZOOM_EXTENTS_EVENT))}
              className="p-1 bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white rounded transition-colors ml-1"
              title="Zoom Extents (ZE)"
            >
              <Maximize2 size={11} />
            </button>
          </div>
        </div>

        {/* Dynamic Multi-View Viewport Area */}
        <div className="flex-1 w-full min-h-0 relative overflow-hidden">
          {/* LAYOUT 1: Split 2V (Side-by-side: 2D Plan on Left, 3D on Right) */}
          {viewLayout === 'split-2v' && (
            <div className="w-full h-full flex flex-row relative">
              {/* Left Pane: 2D Plan / Elevation / Section / Sheet */}
              <div
                className="h-full relative overflow-hidden flex flex-col border-r border-slate-700/80"
                style={{ width: `${splitRatio * 100}%` }}
              >
                {/* View Header Badge */}
                <div className="h-5 bg-slate-800/90 border-b border-slate-700 px-2 flex items-center justify-between text-[10px] text-slate-300 z-10 flex-shrink-0">
                  <div className="flex items-center space-x-1.5 font-semibold text-sky-300">
                    <Layers size={11} />
                    <span>{isSheetActive ? 'Sheet: A101' : activeView?.name || 'Floor Plan'}</span>
                  </div>
                  <span className="text-slate-400 text-[9px] font-mono">
                    {isSheetActive ? '1:1 Layout' : activeView?.scale || '1/4" = 1\'-0"'}
                  </span>
                </div>

                <div className="flex-1 w-full min-h-0 relative">
                  {isSheetActive ? <SheetCanvas /> : <PlanViewport2D />}
                </div>
              </div>

              {/* Draggable Divider */}
              <div
                onMouseDown={() => {
                  isDraggingSplit.current = true;
                  document.body.style.cursor = 'col-resize';
                }}
                className="w-1.5 h-full bg-slate-800 hover:bg-sky-500 cursor-col-resize transition-colors z-20 flex items-center justify-center group flex-shrink-0"
                title="Drag to resize 2D / 3D split"
              >
                <div className="w-0.5 h-8 bg-slate-600 group-hover:bg-white rounded" />
              </div>

              {/* Right Pane: 3D Viewport with ViewCube and Section Cut Bar */}
              <div className="h-full flex-1 relative overflow-hidden flex flex-col">
                {/* 3D View Header Badge */}
                <div className="h-5 bg-slate-800/90 border-b border-slate-700 px-2 flex items-center justify-between text-[10px] text-slate-300 z-10 flex-shrink-0">
                  <div className="flex items-center space-x-1.5 font-semibold text-emerald-300">
                    <Box size={11} />
                    <span>{'{3D} Perspective Model'}</span>
                  </div>
                  <span className="text-slate-400 text-[9px] font-mono">Three.js WebGL</span>
                </div>

                <div className="flex-1 w-full min-h-0 relative">
                  <Viewport3D />
                </div>
              </div>
            </div>
          )}

          {/* LAYOUT 2: Quad 4-View (Top-Left: Plan, Top-Right: 3D, Bottom-Left: Elevation, Bottom-Right: Section) */}
          {viewLayout === 'quad' && (
            <div className="w-full h-full grid grid-cols-2 grid-rows-2 gap-1 bg-slate-900 p-1">
              {/* Quadrant 1 (Top-Left): Floor Plan (Level 1) */}
              <div className="relative w-full h-full flex flex-col bg-slate-950 rounded border border-slate-700/80 overflow-hidden shadow-inner">
                <div className="h-5 bg-slate-800/95 border-b border-slate-700 px-2 flex items-center justify-between text-[10px] text-slate-200 z-10 flex-shrink-0">
                  <span className="font-bold text-sky-300">Top / Floor Plan (Level 1)</span>
                  <span className="text-slate-400 text-[9px]">Plan View</span>
                </div>
                <div className="flex-1 w-full min-h-0 relative">
                  <PlanViewport2D viewId="view-level-1" />
                </div>
              </div>

              {/* Quadrant 2 (Top-Right): 3D Perspective Model */}
              <div className="relative w-full h-full flex flex-col bg-slate-950 rounded border border-slate-700/80 overflow-hidden shadow-inner">
                <div className="h-5 bg-slate-800/95 border-b border-slate-700 px-2 flex items-center justify-between text-[10px] text-slate-200 z-10 flex-shrink-0">
                  <span className="font-bold text-emerald-300">{'{3D} Model View'}</span>
                  <span className="text-slate-400 text-[9px]">Perspective</span>
                </div>
                <div className="flex-1 w-full min-h-0 relative">
                  <Viewport3D />
                </div>
              </div>

              {/* Quadrant 3 (Bottom-Left): South Elevation */}
              <div className="relative w-full h-full flex flex-col bg-slate-950 rounded border border-slate-700/80 overflow-hidden shadow-inner">
                <div className="h-5 bg-slate-800/95 border-b border-slate-700 px-2 flex items-center justify-between text-[10px] text-slate-200 z-10 flex-shrink-0">
                  <span className="font-bold text-amber-300">Front / South Elevation</span>
                  <span className="text-slate-400 text-[9px]">Elevation View</span>
                </div>
                <div className="flex-1 w-full min-h-0 relative">
                  <PlanViewport2D viewId="view-elev-s" />
                </div>
              </div>

              {/* Quadrant 4 (Bottom-Right): Building Section 1 */}
              <div className="relative w-full h-full flex flex-col bg-slate-950 rounded border border-slate-700/80 overflow-hidden shadow-inner">
                <div className="h-5 bg-slate-800/95 border-b border-slate-700 px-2 flex items-center justify-between text-[10px] text-slate-200 z-10 flex-shrink-0">
                  <span className="font-bold text-pink-300">Side / Building Section 1</span>
                  <span className="text-slate-400 text-[9px]">Cut Section</span>
                </div>
                <div className="flex-1 w-full min-h-0 relative">
                  <PlanViewport2D viewId="view-section-1" />
                </div>
              </div>
            </div>
          )}

          {/* LAYOUT 3: Split 2H (Stacked: 2D on Top, 3D on Bottom) */}
          {viewLayout === 'split-2h' && (
            <div className="w-full h-full flex flex-col relative">
              <div className="flex-1 w-full relative overflow-hidden flex flex-col border-b border-slate-700/80">
                <div className="h-5 bg-slate-800/90 border-b border-slate-700 px-2 flex items-center justify-between text-[10px] text-slate-300 z-10 flex-shrink-0">
                  <span className="font-semibold text-sky-300">
                    {isSheetActive ? 'Sheet: A101' : activeView?.name || 'Floor Plan'}
                  </span>
                </div>
                <div className="flex-1 w-full min-h-0 relative">
                  {isSheetActive ? <SheetCanvas /> : <PlanViewport2D />}
                </div>
              </div>

              <div className="flex-1 w-full relative overflow-hidden flex flex-col">
                <div className="h-5 bg-slate-800/90 border-b border-slate-700 px-2 flex items-center justify-between text-[10px] text-slate-300 z-10 flex-shrink-0">
                  <span className="font-semibold text-emerald-300">{'{3D} Perspective Model'}</span>
                </div>
                <div className="flex-1 w-full min-h-0 relative">
                  <Viewport3D />
                </div>
              </div>
            </div>
          )}

          {/* LAYOUT 4: Single 3D */}
          {viewLayout === 'single-3d' && (
            <div className="w-full h-full relative">
              <Viewport3D />
            </div>
          )}

          {/* LAYOUT 5: Single 2D */}
          {viewLayout === 'single-2d' && (
            <div className="w-full h-full relative">
              {isSheetActive ? <SheetCanvas /> : <PlanViewport2D />}
            </div>
          )}

          {/* LAYOUT 6: MDI Tabs (Dockview React) */}
          {viewLayout === 'tabs' && (
            <div className="w-full h-full dockview-theme-dark">
              <DockviewReact
                components={components}
                onReady={onReady}
                className="dockview-theme-dark h-full w-full"
              />
            </div>
          )}
        </div>
      </div>

      {/* 3. Right Dock: Properties Palette */}
      {isPropertiesOpen ? (
        <div className="w-[290px] h-full flex-shrink-0 relative border-l border-[#cbd5e1] shadow-sm z-10 flex flex-col">
          <PropertiesPalette />
          <button
            onClick={() => setIsPropertiesOpen(false)}
            className="absolute top-2 left-1.5 p-1 bg-slate-200 hover:bg-slate-300 rounded text-slate-600 transition-colors z-20"
            title="Collapse Properties Palette"
          >
            <ChevronRight size={13} />
          </button>
        </div>
      ) : (
        <button
          onClick={() => setIsPropertiesOpen(true)}
          className="w-5 h-full bg-[#f1f5f9] hover:bg-[#e2e8f0] border-l border-[#cbd5e1] flex items-center justify-center text-slate-500 z-10 transition-colors"
          title="Expand Properties Palette"
        >
          <ChevronLeft size={14} />
        </button>
      )}
    </div>
  );
};
