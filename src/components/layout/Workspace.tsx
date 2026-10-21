import React, { useState, useEffect, useRef } from 'react';
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
  X,
  Plus,
  SlidersHorizontal,
  FolderOpen,
  Maximize,
  Compass,
  RotateCw,
  Sparkles,
  Glasses,
  Sun,
  LayoutGrid,
} from 'lucide-react';
import {
  useBimStore,
  TILE_WINDOWS_EVENT,
  TAB_VIEWS_EVENT,
  ZOOM_EXTENTS_EVENT,
} from '../../store/useBimStore';
import { ProjectBrowser } from '../browser/ProjectBrowser';
import { PropertiesPalette } from '../properties/PropertiesPalette';
import { Viewport3D } from '../viewport/Viewport3D';
import { PlanViewport2D } from '../drafting/PlanViewport2D';
import { SheetCanvas } from '../sheets/SheetCanvas';

export const Workspace: React.FC = () => {
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
    activeScale,
    setScale,
    activeDetailLevel,
    setDetailLevel,
    activeVisualStyle,
    setVisualStyle,
    cameraProjection,
    setCameraProjection,
    hiddenGuids,
    isolatedGuids,
    resetTempVisibility,
    tempHideSelected,
    selectedGuid,
    setViewRangeModalOpen,
    displayUnit,
    setDisplayUnit,
    sectionBox,
    toggleSectionBox,
  } = useBimStore();

  // Left sidebar management (stacked Properties over Project Browser - Revit / BIMCraft standard)
  const [sidebarWidth, setSidebarWidth] = useState<number>(310);
  const [isSidebarOpen, setIsSidebarOpen] = useState<boolean>(true);
  const [sidebarMode, setSidebarMode] = useState<'both' | 'properties' | 'browser'>('both');
  const [sidebarSplitRatio, setSidebarSplitRatio] = useState<number>(0.52); // Properties 52%, Browser 48%
  const isDraggingSidebarWidth = useRef<boolean>(false);
  const isDraggingSidebarSplit = useRef<boolean>(false);

  // Multi-view split management (WT Split 2V: 2D on Left, 3D on Right)
  const [splitRatio, setSplitRatio] = useState<number>(0.5);
  const isDraggingSplit = useRef<boolean>(false);

  // Open Document Tabs management (BIMCraft view_tabs)
  const [openViewIds, setOpenViewIds] = useState<string[]>([
    'view-3d',
    'view-level-1',
    'view-level-2',
    'sheet-a101',
  ]);

  // Keep openViewIds updated when an activeViewId or activeSheetId is selected
  useEffect(() => {
    if (activeViewId && !openViewIds.includes(activeViewId)) {
      setOpenViewIds((prev) => [...prev, activeViewId]);
    }
  }, [activeViewId, openViewIds]);

  useEffect(() => {
    if (activeSheetId && !openViewIds.includes(activeSheetId)) {
      setOpenViewIds((prev) => [...prev, activeSheetId]);
    }
  }, [activeSheetId, openViewIds]);

  const activeView = views.find((v) => v.id === activeViewId);
  const isSheetActive =
    activeView?.type === 'sheet' ||
    activeViewId.startsWith('sheet-') ||
    (activeSheetId && activeViewId === activeSheetId);

  // Drag resizing for sidebar width and vertical stack
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (isDraggingSidebarWidth.current) {
        const newWidth = Math.max(220, Math.min(550, e.clientX));
        setSidebarWidth(newWidth);
      } else if (isDraggingSidebarSplit.current) {
        const sidebarElem = document.getElementById('bimworks-left-sidebar');
        if (sidebarElem) {
          const rect = sidebarElem.getBoundingClientRect();
          const relativeY = e.clientY - rect.top;
          const ratio = Math.max(0.15, Math.min(0.85, relativeY / rect.height));
          setSidebarSplitRatio(ratio);
        }
      } else if (isDraggingSplit.current) {
        const startX = isSidebarOpen ? sidebarWidth : 24;
        const totalWidth = window.innerWidth - startX;
        const ratio = Math.max(0.15, Math.min(0.85, (e.clientX - startX) / totalWidth));
        setSplitRatio(ratio);
      }
    };

    const handleMouseUp = () => {
      isDraggingSidebarWidth.current = false;
      isDraggingSidebarSplit.current = false;
      isDraggingSplit.current = false;
      document.body.style.cursor = 'default';
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isSidebarOpen, sidebarWidth]);

  // Listen to Window Tiling & Tab commands (WT / TW / ZE)
  useEffect(() => {
    const handleTile = () => {
      setViewLayout('split-2v');
    };

    const handleTabViews = () => {
      setViewLayout('single-2d');
    };

    window.addEventListener(TILE_WINDOWS_EVENT, handleTile);
    window.addEventListener(TAB_VIEWS_EVENT, handleTabViews);
    window.addEventListener('bimworks-tab-windows', handleTabViews);
    return () => {
      window.removeEventListener(TILE_WINDOWS_EVENT, handleTile);
      window.removeEventListener(TAB_VIEWS_EVENT, handleTabViews);
      window.removeEventListener('bimworks-tab-windows', handleTabViews);
    };
  }, [setViewLayout]);

  // Helper to close a document tab
  const handleCloseTab = (idToClose: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (openViewIds.length <= 1) return; // Keep at least one tab open
    const filtered = openViewIds.filter((id) => id !== idToClose);
    setOpenViewIds(filtered);
    if (activeViewId === idToClose) {
      const nextId = filtered[filtered.length - 1];
      setActiveViewId(nextId);
      if (nextId.startsWith('sheet-')) {
        setActiveSheetId(nextId);
      }
    }
  };

  // Helper to get view tab display metadata
  const getViewTabMeta = (id: string) => {
    if (id === 'view-3d') {
      return {
        name: '{3D}',
        type: '3d',
        icon: <Box size={13} className="text-[#2563eb]" />,
      };
    }
    const foundSheet = sheets.find((s) => s.id === id);
    if (foundSheet || id.startsWith('sheet-')) {
      const label = foundSheet ? `${foundSheet.sheetNumber} - ${foundSheet.sheetTitle}` : id.toUpperCase();
      return {
        name: label,
        type: 'sheet',
        icon: <FileSpreadsheet size={13} className="text-[#7c3aed]" />,
      };
    }
    const foundView = views.find((v) => v.id === id);
    if (foundView) {
      let icon = <Layers size={13} className="text-[#0284c7]" />;
      if (foundView.type === 'section') {
        icon = <Scissors size={13} className="text-[#db2777]" />;
      } else if (foundView.type === 'elevation') {
        icon = <Eye size={13} className="text-[#059669]" />;
      }
      return {
        name: foundView.name,
        type: foundView.type,
        icon,
      };
    }
    return {
      name: id,
      type: 'plan',
      icon: <Layers size={13} className="text-[#64748b]" />,
    };
  };

  const isTempActive = hiddenGuids.length > 0 || isolatedGuids.length > 0;

  return (
    <div className="flex-1 w-full h-full flex overflow-hidden bg-[#f1f5f9] select-none font-sans relative">
      {/* 1. LEFT DOCK: Unified Properties + Project Browser (BIMCraft / Revit standard) */}
      {isSidebarOpen ? (
        <div
          id="bimworks-left-sidebar"
          style={{ width: `${sidebarWidth}px` }}
          className="h-full flex-shrink-0 relative border-r border-[#cbd5e1] bg-[#f8fafc] flex flex-col z-20 shadow-xs"
        >
          {/* Sidebar Top Switcher Header (Both / Properties / Browser) */}
          <div className="h-7 bg-[#f1f5f9] border-b border-[#cbd5e1] px-2 flex items-center justify-between text-[11px] text-[#475569] shrink-0">
            <div className="flex items-center space-x-1">
              <button
                onClick={() => setSidebarMode('both')}
                className={`px-1.5 py-0.5 rounded text-[10px] font-semibold transition-colors ${
                  sidebarMode === 'both'
                    ? 'bg-white text-[#0f172a] shadow-2xs border border-[#cbd5e1]'
                    : 'hover:bg-[#e2e8f0] text-[#64748b]'
                }`}
                title="Show Properties on top, Project Browser on bottom"
              >
                Split
              </button>
              <button
                onClick={() => setSidebarMode('properties')}
                className={`px-1.5 py-0.5 rounded text-[10px] font-semibold transition-colors ${
                  sidebarMode === 'properties'
                    ? 'bg-white text-[#0f172a] shadow-2xs border border-[#cbd5e1]'
                    : 'hover:bg-[#e2e8f0] text-[#64748b]'
                }`}
                title="Maximize Properties Palette"
              >
                Properties
              </button>
              <button
                onClick={() => setSidebarMode('browser')}
                className={`px-1.5 py-0.5 rounded text-[10px] font-semibold transition-colors ${
                  sidebarMode === 'browser'
                    ? 'bg-white text-[#0f172a] shadow-2xs border border-[#cbd5e1]'
                    : 'hover:bg-[#e2e8f0] text-[#64748b]'
                }`}
                title="Maximize Project Browser"
              >
                Browser
              </button>
            </div>

            {/* Collapse Sidebar Button */}
            <button
              onClick={() => setIsSidebarOpen(false)}
              className="p-1 hover:bg-[#e2e8f0] rounded text-[#64748b] hover:text-[#0f172a] transition-colors"
              title="Collapse Side Palettes"
            >
              <ChevronLeft size={13} />
            </button>
          </div>

          {/* Sidebar Content Area */}
          <div className="flex-1 w-full min-h-0 flex flex-col relative overflow-hidden">
            {sidebarMode === 'both' && (
              <>
                {/* Properties (Top Half) */}
                <div
                  style={{ height: `${sidebarSplitRatio * 100}%` }}
                  className="w-full relative overflow-hidden flex flex-col min-h-[120px]"
                >
                  <PropertiesPalette />
                </div>

                {/* Vertical Splitter between Properties & Browser */}
                <div
                  onMouseDown={() => {
                    isDraggingSidebarSplit.current = true;
                    document.body.style.cursor = 'row-resize';
                  }}
                  className="h-1.5 w-full bg-[#e2e8f0] hover:bg-[#2563eb] cursor-row-resize flex items-center justify-center transition-colors shrink-0 z-10 group"
                  title="Drag to resize Properties / Project Browser split"
                >
                  <div className="w-8 h-0.5 bg-[#94a3b8] group-hover:bg-white rounded" />
                </div>

                {/* Project Browser (Bottom Half) */}
                <div className="flex-1 w-full min-h-[100px] relative overflow-hidden flex flex-col">
                  <ProjectBrowser />
                </div>
              </>
            )}

            {sidebarMode === 'properties' && (
              <div className="w-full h-full relative overflow-hidden flex flex-col">
                <PropertiesPalette />
              </div>
            )}

            {sidebarMode === 'browser' && (
              <div className="w-full h-full relative overflow-hidden flex flex-col">
                <ProjectBrowser />
              </div>
            )}
          </div>

          {/* Right Edge Resizer for Sidebar Width */}
          <div
            onMouseDown={() => {
              isDraggingSidebarWidth.current = true;
              document.body.style.cursor = 'col-resize';
            }}
            className="absolute top-0 right-0 w-1 h-full cursor-col-resize hover:bg-[#2563eb] transition-colors z-30"
            title="Drag to adjust palette width"
          />
        </div>
      ) : (
        /* Collapsed Sidebar Rail */
        <div className="w-6 h-full bg-[#f1f5f9] border-r border-[#cbd5e1] flex flex-col items-center py-2 z-20 shrink-0">
          <button
            onClick={() => setIsSidebarOpen(true)}
            className="p-1 hover:bg-[#e2e8f0] rounded text-[#475569] hover:text-[#0f172a] transition-colors mb-4"
            title="Expand Palettes (Properties & Browser)"
          >
            <ChevronRight size={14} />
          </button>
          <div
            onClick={() => setIsSidebarOpen(true)}
            className="text-[10px] font-bold text-[#64748b] tracking-widest uppercase cursor-pointer hover:text-[#0f172a] select-none"
            style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}
          >
            Properties & Browser
          </div>
        </div>
      )}

      {/* 2. CENTER STAGE: Document Tabs Bar + Canvas + View Control Bar */}
      <div className="flex-1 h-full flex flex-col min-w-0 min-h-0 bg-[#0f172a] relative overflow-hidden">
        {/* Top Revit Document View Tabs Bar (BIMCraft view_tabs) */}
        <div className="h-8 bg-[#e2e8f0] border-b border-[#cbd5e1] px-1.5 flex items-center justify-between text-xs select-none z-20 flex-shrink-0">
          {/* Scrollable Tabs */}
          <div className="flex items-center space-x-0.5 overflow-x-auto h-full pt-1">
            {openViewIds.map((id) => {
              const meta = getViewTabMeta(id);
              const isActive = activeViewId === id;
              return (
                <div
                  key={id}
                  onClick={() => {
                    setActiveViewId(id);
                    if (id.startsWith('sheet-')) {
                      setActiveSheetId(id);
                    }
                  }}
                  className={`flex items-center space-x-1.5 px-3 h-[27px] rounded-t text-[11px] cursor-pointer transition-all border-t border-l border-r group relative select-none ${
                    isActive
                      ? 'bg-white text-[#0f172a] font-semibold border-t-2 border-t-[#2563eb] border-l-[#cbd5e1] border-r-[#cbd5e1] shadow-2xs'
                      : 'bg-[#f1f5f9] text-[#475569] hover:bg-[#e5e7eb] hover:text-[#0f172a] border-transparent'
                  }`}
                  title={meta.name}
                >
                  <span className="shrink-0">{meta.icon}</span>
                  <span className="truncate max-w-[150px]">{meta.name}</span>

                  {/* Close Tab Button */}
                  {openViewIds.length > 1 && (
                    <button
                      onClick={(e) => handleCloseTab(id, e)}
                      className={`p-0.5 rounded hover:bg-slate-200 text-slate-400 hover:text-slate-700 transition-opacity ml-1 ${
                        isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                      }`}
                      title={`Close ${meta.name}`}
                    >
                      <X size={10} />
                    </button>
                  )}
                </div>
              );
            })}
          </div>

          {/* Right: Quick Layout Buttons (Tabs TW / Tile WT / Zoom Extents ZE) */}
          <div className="flex items-center space-x-1 pl-2">
            {/* Tab Views (TW) */}
            <button
              onClick={() => {
                setViewLayout('single-2d');
                window.dispatchEvent(new CustomEvent(TAB_VIEWS_EVENT));
              }}
              className={`flex items-center space-x-1 px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${
                viewLayout !== 'split-2v' && viewLayout !== 'quad'
                  ? 'bg-white text-[#0f172a] shadow-2xs font-semibold'
                  : 'bg-slate-200/80 text-slate-700 hover:bg-white hover:text-slate-900'
              }`}
              title="Tab Views (TW) - Single Full-Canvas View"
            >
              <span>Tabs (TW)</span>
            </button>

            {/* Tile Windows (WT) */}
            <button
              onClick={() => {
                setViewLayout('split-2v');
                window.dispatchEvent(new CustomEvent(TILE_WINDOWS_EVENT));
              }}
              className={`flex items-center space-x-1 px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${
                viewLayout === 'split-2v'
                  ? 'bg-white text-[#0f172a] shadow-2xs font-semibold'
                  : 'bg-slate-200/80 text-slate-700 hover:bg-white hover:text-slate-900'
              }`}
              title="Tile Windows (WT) - Side-by-Side 2D Plan & 3D Model"
            >
              <Columns2 size={11} />
              <span>Tile (WT)</span>
            </button>

            {/* Zoom Extents (ZE) */}
            <button
              onClick={() => window.dispatchEvent(new CustomEvent(ZOOM_EXTENTS_EVENT))}
              className="p-1 bg-slate-200/80 hover:bg-white text-slate-700 hover:text-slate-900 rounded transition-colors ml-0.5"
              title="Zoom Extents (ZE)"
            >
              <Maximize2 size={11} />
            </button>
          </div>
        </div>

        {/* Viewport Canvas Area */}
        <div className="flex-1 w-full min-h-0 relative overflow-hidden bg-[#0f172a]">
          {/* LAYOUT A: Split 2V (Side-by-side 2D Plan & 3D Model) */}
          {viewLayout === 'split-2v' ? (
            <div className="w-full h-full flex flex-row relative">
              {/* Left Pane: 2D Plan / Elevation / Section / Sheet */}
              <div
                className="h-full relative overflow-hidden flex flex-col border-r border-slate-700/80"
                style={{ width: `${splitRatio * 100}%` }}
              >
                <div className="h-5 bg-slate-800/95 border-b border-slate-700 px-2 flex items-center justify-between text-[10px] text-slate-300 z-10 shrink-0">
                  <div className="flex items-center space-x-1.5 font-semibold text-sky-300">
                    <Layers size={11} />
                    <span>{isSheetActive ? 'Sheet: A101' : activeView?.name || 'Floor Plan'}</span>
                  </div>
                  <span className="text-slate-400 text-[9px] font-mono">
                    {isSheetActive ? '1:1 Layout' : activeScale || '1/4" = 1\'-0"'}
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
                className="w-1.5 h-full bg-slate-800 hover:bg-[#2563eb] cursor-col-resize transition-colors z-20 flex items-center justify-center group shrink-0"
                title="Drag to resize 2D / 3D split"
              >
                <div className="w-0.5 h-8 bg-slate-600 group-hover:bg-white rounded" />
              </div>

              {/* Right Pane: 3D Viewport with ViewCube */}
              <div className="h-full flex-1 relative overflow-hidden flex flex-col">
                <div className="h-5 bg-slate-800/95 border-b border-slate-700 px-2 flex items-center justify-between text-[10px] text-slate-300 z-10 shrink-0">
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
          ) : activeViewId === 'view-3d' ? (
            /* Single 3D Viewport */
            <div className="w-full h-full relative">
              <Viewport3D />
            </div>
          ) : isSheetActive ? (
            /* Single Sheet Viewport */
            <div className="w-full h-full relative">
              <SheetCanvas />
            </div>
          ) : (
            /* Single 2D Plan / Elevation / Section Viewport */
            <div className="w-full h-full relative">
              <PlanViewport2D />
            </div>
          )}
        </div>

        {/* 3. Docked View Control Bar (Revit view_control_bar at bottom of canvas) */}
        <div className="h-6 bg-[#f1f5f9] border-t border-[#cbd5e1] px-2 flex items-center justify-between text-[10px] text-[#334155] select-none z-20 shrink-0 font-sans">
          <div className="flex items-center space-x-1.5">
            {/* Units Selector */}
            <select
              value={displayUnit}
              onChange={(e) => setDisplayUnit(e.target.value as any)}
              className="bg-white border border-[#cbd5e1] text-[#2563eb] font-semibold rounded px-1 py-0.5 text-[10px] cursor-pointer focus:outline-none"
              title="Display Units"
            >
              <option value="metric_mm">Metric (mm)</option>
              <option value="metric_m">Metric (m)</option>
              <option value="imperial_fractional">Fract (Ft-In)</option>
              <option value="imperial_decimal">Dec Feet</option>
            </select>

            {/* Scale Selector */}
            <select
              value={activeScale}
              onChange={(e) => setScale(e.target.value)}
              className="bg-white border border-[#cbd5e1] text-[#0f172a] font-medium rounded px-1 py-0.5 text-[10px] cursor-pointer focus:outline-none"
              title="View Scale"
            >
              <option value="1:100">1:100</option>
              <option value="1:50">1:50</option>
              <option value="1:20">1:20</option>
              <option value='1/4" = 1&apos;-0"'>1/4" = 1'-0"</option>
              <option value='1/8" = 1&apos;-0"'>1/8" = 1'-0"</option>
              <option value='1/2" = 1&apos;-0"'>1/2" = 1'-0"</option>
            </select>

            {/* Detail Level */}
            <div className="flex items-center bg-white border border-[#cbd5e1] rounded px-0.5">
              {(['coarse', 'medium', 'fine'] as const).map((lvl) => (
                <button
                  key={lvl}
                  onClick={() => setDetailLevel(lvl)}
                  className={`px-1.5 py-0.5 rounded capitalize text-[10px] ${
                    activeDetailLevel === lvl
                      ? 'bg-[#dbeafe] text-[#1d4ed8] font-bold'
                      : 'text-[#64748b] hover:text-[#0f172a]'
                  }`}
                >
                  {lvl}
                </button>
              ))}
            </div>

            {/* Visual Style */}
            <div className="flex items-center bg-white border border-[#cbd5e1] rounded px-0.5">
              <button
                onClick={() => setVisualStyle('hidden_line')}
                className={`px-1.5 py-0.5 rounded text-[10px] ${
                  activeVisualStyle === 'hidden_line'
                    ? 'bg-[#dbeafe] text-[#1d4ed8] font-bold'
                    : 'text-[#64748b] hover:text-[#0f172a]'
                }`}
                title="Hidden Line (HL)"
              >
                HL
              </button>
              <button
                onClick={() => setVisualStyle('consistent_colors')}
                className={`px-1.5 py-0.5 rounded text-[10px] ${
                  activeVisualStyle === 'consistent_colors'
                    ? 'bg-[#dbeafe] text-[#1d4ed8] font-bold'
                    : 'text-[#64748b] hover:text-[#0f172a]'
                }`}
                title="Consistent Colors (CC)"
              >
                CC
              </button>
              <button
                onClick={() => setVisualStyle('wireframe')}
                className={`px-1.5 py-0.5 rounded text-[10px] ${
                  activeVisualStyle === 'wireframe'
                    ? 'bg-[#dbeafe] text-[#1d4ed8] font-bold'
                    : 'text-[#64748b] hover:text-[#0f172a]'
                }`}
                title="Wireframe (WF)"
              >
                WF
              </button>
            </div>

            {/* 3D Camera Projection */}
            <div className="flex items-center bg-white border border-[#cbd5e1] rounded px-0.5">
              <button
                onClick={() => setCameraProjection('perspective')}
                className={`px-1.5 py-0.5 rounded text-[10px] ${
                  cameraProjection === 'perspective'
                    ? 'bg-[#dbeafe] text-[#1d4ed8] font-bold'
                    : 'text-[#64748b] hover:text-[#0f172a]'
                }`}
                title="Perspective 3D View"
              >
                Persp
              </button>
              <button
                onClick={() => setCameraProjection('isometric')}
                className={`px-1.5 py-0.5 rounded text-[10px] ${
                  cameraProjection === 'isometric'
                    ? 'bg-[#dbeafe] text-[#1d4ed8] font-bold'
                    : 'text-[#64748b] hover:text-[#0f172a]'
                }`}
                title="Isometric (Orthographic) 3D View"
              >
                Iso
              </button>
            </div>

            {/* View Range Modal */}
            <button
              onClick={() => setViewRangeModalOpen(true)}
              className="p-1 hover:bg-[#e2e8f0] rounded text-[#475569] hover:text-[#0284c7] flex items-center space-x-1"
              title="Edit View Range (VR)"
            >
              <SlidersHorizontal size={11} />
              <span>VR</span>
            </button>

            {/* Temporary Hide/Isolate Glasses */}
            <button
              onClick={() => (isTempActive ? resetTempVisibility() : selectedGuid && tempHideSelected())}
              className={`px-1.5 py-0.5 rounded flex items-center space-x-1 border ${
                isTempActive
                  ? 'bg-[#2563eb] text-white border-[#2563eb] font-bold'
                  : 'border-transparent hover:bg-[#e2e8f0] text-[#475569]'
              }`}
              title="Temporary Hide/Isolate (HH / HR)"
            >
              <Glasses size={12} />
              {isTempActive && <span>Active</span>}
            </button>

            {/* Section Box (BX) */}
            <button
              onClick={() => toggleSectionBox()}
              className={`px-1.5 py-0.5 rounded text-[10px] font-medium border ${
                sectionBox.enabled
                  ? 'bg-[#dbeafe] text-[#1d4ed8] border-[#93c5fd] font-semibold'
                  : 'border-transparent hover:bg-[#e2e8f0] text-[#64748b]'
              }`}
              title="Section Box (BX)"
            >
              BX
            </button>
          </div>

          <div className="flex items-center space-x-2 text-[10px] text-[#64748b]">
            <span>{activeView?.name || 'View'}</span>
          </div>
        </div>
      </div>
    </div>
  );
};
