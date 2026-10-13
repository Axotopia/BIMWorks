import React, { useRef, useEffect } from 'react';
import {
  FolderOpen,
  Save,
  RotateCcw,
  RotateCw,
  Box,
  Layers,
  DoorClosed,
  AppWindow,
  Square,
  Home,
  Grid,
  Ruler,
  Maximize2,
  FileText,
  FileSpreadsheet,
  Globe,
  Settings,
  Tag,
  PenTool,
  Download,
  Scissors,
  Eye,
  Lock,
  Equal,
  Sparkles,
  Upload,
} from 'lucide-react';
import { useBimStore } from '../../store/useBimStore';
import { ActiveTool } from '../../types/bim';

export const Ribbon: React.FC = () => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const {
    activeRibbonTab,
    setActiveRibbonTab,
    activeTool,
    setActiveTool,
    toggleSectionBox,
    sectionBox,
    exportIfc,
    exportOrltProject,
    loadSampleProject,
    loadIfcFile,
    loadOrltFile,
    undoTransaction,
    redoTransaction,
    setPromptBarOpen,
    isLoadingFile,
    setGeoreferenceModalOpen,
    setActiveViewId,
    setActiveSheetId,
    keyBuffer,
  } = useBimStore();

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        fileInputRef.current?.click();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const handleOpenFileClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      if (file.name.toLowerCase().endsWith('.orlt')) {
        await loadOrltFile(file);
      } else {
        await loadIfcFile(file);
      }
      e.target.value = '';
    }
  };

  const tabs = ['Architecture', 'Annotate', 'View', 'Manage'] as const;

  const renderToolButton = (
    tool: ActiveTool,
    label: string,
    shortcut: string,
    icon: React.ReactNode,
    onClick?: () => void
  ) => {
    const isActive = activeTool === tool;
    return (
      <button
        onClick={() => {
          if (onClick) onClick();
          else setActiveTool(tool);
        }}
        className={`flex flex-col items-center justify-center px-3 py-1.5 rounded transition-all group relative border ${
          isActive
            ? 'bg-[#094771] border-[#007acc] text-white shadow-sm'
            : 'border-transparent hover:bg-[#333333] hover:border-[#444444] text-[#cccccc]'
        }`}
        title={`${label} (${shortcut})`}
      >
        <div className="w-6 h-6 flex items-center justify-center mb-1 group-hover:scale-105 transition-transform">
          {icon}
        </div>
        <span className="text-[11px] font-medium leading-none tracking-tight">{label}</span>
        <span className="absolute top-1 right-1 text-[9px] font-mono text-[#858585] group-hover:text-[#38bdf8]">
          {shortcut}
        </span>
      </button>
    );
  };

  return (
    <div className="flex flex-col bg-[#252526] border-b border-[#3c3c3c] select-none text-[#cccccc] shadow-md z-30">
      {/* Top Application Bar & Quick Access Toolbar */}
      <div className="flex items-center justify-between px-3 py-1 bg-[#1e1e1e] border-b border-[#333333] text-xs">
        <div className="flex items-center space-x-3">
          <div className="flex items-center space-x-1.5">
            <div className="w-6 h-5 bg-[#007acc] rounded flex items-center justify-center font-bold text-[10px] text-white shadow-sm tracking-tighter">
              BW
            </div>
            <span className="font-semibold text-white tracking-wide text-xs">BIMWorks</span>
            <span className="text-[10px] text-[#858585] bg-[#2d2d2d] px-1.5 py-0.5 rounded border border-[#3c3c3c]">
              IFC4 Native
            </span>
          </div>

          <div className="h-4 w-[1px] bg-[#3c3c3c]" />

          {/* Quick Access Icons */}
          <div className="flex items-center space-x-1">
            <button
              onClick={handleOpenFileClick}
              className="p-1 hover:bg-[#333333] rounded text-[#cccccc] hover:text-white"
              title="Open IFC File (.ifc, .step) - Ctrl+O"
            >
              <FolderOpen size={14} className={isLoadingFile ? 'text-[#38bdf8] animate-pulse' : ''} />
            </button>
            <button
              onClick={() => exportOrltProject()}
              className="p-1 hover:bg-[#333333] rounded text-[#cccccc] hover:text-white"
              title="Save Project Container (.orlt)"
            >
              <Save size={14} className="text-[#38bdf8]" />
            </button>
            <button
              onClick={() => exportIfc()}
              className="p-1 hover:bg-[#333333] rounded text-[#cccccc] hover:text-white"
              title="Export Standard IFC4 (.ifc)"
            >
              <Download size={14} />
            </button>
            <button
              onClick={() => undoTransaction()}
              className="p-1 hover:bg-[#333333] rounded text-[#cccccc] hover:text-white"
              title="Undo Transaction (Ctrl+Z)"
            >
              <RotateCcw size={14} />
            </button>
            <button
              onClick={() => redoTransaction()}
              className="p-1 hover:bg-[#333333] rounded text-[#cccccc] hover:text-white"
              title="Redo Transaction (Ctrl+Y)"
            >
              <RotateCw size={14} />
            </button>
            <div className="h-3 w-[1px] bg-[#3c3c3c] mx-1" />
            <button
              onClick={() => setActiveViewId('view-3d')}
              className="p-1 hover:bg-[#333333] rounded text-[#cccccc] hover:text-white"
              title="Default 3D View ({3D})"
            >
              <Home size={14} />
            </button>
            <button
              onClick={() => toggleSectionBox()}
              className={`p-1 rounded ${
                sectionBox.enabled
                  ? 'bg-[#094771] text-[#38bdf8]'
                  : 'hover:bg-[#333333] text-[#cccccc] hover:text-white'
              }`}
              title="Real-Time Section Box (BX)"
            >
              <Scissors size={14} />
            </button>
          </div>
        </div>

        {/* Middle Project Title */}
        <div className="text-[11px] text-[#969696] font-medium hidden md:block">
          BIMWorks 2026.1 — Native-IFC Architectural BIM &amp; Construction Documents
        </div>

        {/* Right Status / Hotkey Buffer Indicator */}
        <div className="flex items-center space-x-2">
          {keyBuffer && (
            <div className="bg-[#0284c7] text-white px-2 py-0.5 rounded text-[10px] font-mono font-bold animate-pulse">
              HOTKEY: [{keyBuffer}_]
            </div>
          )}
          <span className="text-[10px] text-[#71717a] font-mono">buildSMART IFC4 RV</span>
        </div>
      </div>

      {/* Ribbon Tab Bar */}
      <div className="flex items-center px-2 pt-1 border-b border-[#3c3c3c] space-x-1 bg-[#252526]">
        {tabs.map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveRibbonTab(tab)}
            className={`px-3 py-1 text-xs font-medium rounded-t border-t border-l border-r transition-colors ${
              activeRibbonTab === tab
                ? 'bg-[#1e1e1e] border-[#3c3c3c] text-white font-semibold'
                : 'border-transparent text-[#969696] hover:text-[#d4d4d4] hover:bg-[#2d2d2d]'
            }`}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* Ribbon Panels Content */}
      <div className="flex items-center px-3 py-2 space-x-6 min-h-[72px] bg-[#1e1e1e] overflow-x-auto">
        {activeRibbonTab === 'Architecture' && (
          <>
            {/* Build Panel */}
            <div className="flex items-center space-x-2 border-r border-[#333333] pr-5">
              {renderToolButton('WA', 'Wall', 'WA', <Box size={20} className="text-[#60a5fa]" />)}
              {renderToolButton('DR', 'Door', 'DR', <DoorClosed size={20} className="text-[#f97316]" />)}
              {renderToolButton('WN', 'Window', 'WN', <AppWindow size={20} className="text-[#38bdf8]" />)}
              {renderToolButton('SB', 'Floor', 'SB', <Layers size={20} className="text-[#a855f7]" />)}
              {renderToolButton('RF', 'Roof', 'RF', <Square size={20} className="text-[#ec4899]" />)}
            </div>

            {/* Datum Panel */}
            <div className="flex items-center space-x-2 border-r border-[#333333] pr-5">
              {renderToolButton('GR', 'Grid', 'GR', <Grid size={20} className="text-[#eab308]" />)}
              {renderToolButton('LL', 'Level', 'LL', <Maximize2 size={20} className="text-[#10b981]" />)}
            </div>

            {/* Constraints & Modify Panel */}
            <div className="flex items-center space-x-2 border-r border-[#333333] pr-5">
              {renderToolButton('AL', 'Align & Lock', 'AL', <Lock size={20} className="text-[#38bdf8]" />)}
              {renderToolButton('EQ', 'Equalize', 'EQ', <Equal size={20} className="text-[#10b981]" />)}
            </div>

            {/* Project Loading & File Open Panel */}
            <div className="flex items-center space-x-2 border-r border-[#333333] pr-5">
              <button
                onClick={handleOpenFileClick}
                disabled={isLoadingFile}
                className="flex items-center space-x-1.5 px-3 py-2 bg-[#1e293b] hover:bg-[#334155] border border-[#0284c7] rounded text-xs text-white shadow-sm transition-colors cursor-pointer"
                title="Open .orlt Hybrid Container or .ifc File (Ctrl+O)"
              >
                <FolderOpen size={15} className="text-[#38bdf8]" />
                <span className="font-medium">{isLoadingFile ? 'Opening...' : 'Open Project / IFC...'}</span>
              </button>
              <button
                onClick={() => exportOrltProject()}
                className="flex items-center space-x-1.5 px-3 py-2 bg-[#064e3b] hover:bg-[#047857] border border-[#059669] rounded text-xs text-white shadow-sm transition-colors cursor-pointer"
                title="Save BIMWorks .orlt Hybrid Container"
              >
                <Save size={14} className="text-[#34d399]" />
                <span>Save Project (.orlt)</span>
              </button>
              <button
                onClick={() => exportIfc()}
                className="flex items-center space-x-1.5 px-3 py-2 bg-[#2a2d2e] hover:bg-[#383b3d] border border-[#3c3c3c] rounded text-xs text-[#94a3b8] hover:text-[#e2e8f0] transition-colors cursor-pointer"
                title="Export Standard IFC4 STEP File (.ifc)"
              >
                <Download size={14} className="text-[#38bdf8]" />
                <span>Export IFC</span>
              </button>
            </div>

            {/* AI Driver & Samples Panel */}
            <div className="flex items-center space-x-2">
              <button
                onClick={() => setPromptBarOpen(true)}
                className="flex items-center space-x-1.5 px-3 py-2 bg-[#0284c7] hover:bg-[#0369a1] border border-[#38bdf8] rounded text-xs text-white font-medium shadow-sm transition-colors cursor-pointer"
                title="Open Tier-1 AI Prompt Bar (/ or Ctrl+Enter)"
              >
                <Sparkles size={14} className="text-white" />
                <span>AI Prompt Bar</span>
              </button>
              <button
                onClick={() => loadSampleProject()}
                disabled={isLoadingFile}
                className="flex items-center space-x-1.5 px-3 py-2 bg-[#2a2d2e] hover:bg-[#383b3d] border border-[#3c3c3c] rounded text-xs text-[#94a3b8] hover:text-[#e2e8f0] transition-colors cursor-pointer"
                title="Load built-in IFC4 architectural sample building"
              >
                <span>Sample BIM</span>
              </button>
            </div>
          </>
        )}

        {activeRibbonTab === 'Annotate' && (
          <div className="flex items-center space-x-2">
            {renderToolButton('DI', 'Aligned Dim', 'DI', <Ruler size={20} className="text-[#38bdf8]" />)}
            {renderToolButton('DL', 'Detail Line', 'DL', <PenTool size={20} className="text-[#e2e8f0]" />)}
            {renderToolButton('TG', 'Tag Category', 'TG', <Tag size={20} className="text-[#f59e0b]" />)}
            {renderToolButton('TX', 'Text', 'TX', <FileText size={20} className="text-[#10b981]" />)}
          </div>
        )}

        {activeRibbonTab === 'View' && (
          <div className="flex items-center space-x-2 border-r border-[#333333] pr-5">
            {renderToolButton(
              'select',
              'Default 3D',
              '{3D}',
              <Home size={20} className="text-[#38bdf8]" />,
              () => setActiveViewId('view-3d')
            )}
            {renderToolButton(
              'select',
              'Floor Plan',
              'L1',
              <Layers size={20} className="text-[#a855f7]" />,
              () => setActiveViewId('view-level-1')
            )}
            {renderToolButton(
              'SEC',
              'Section',
              'SEC',
              <Scissors size={20} className="text-[#f97316]" />,
              () => setActiveViewId('view-section-1')
            )}
            {renderToolButton(
              'SHT',
              'Sheet',
              'SHT',
              <FileSpreadsheet size={20} className="text-[#10b981]" />,
              () => setActiveSheetId('sheet-a101')
            )}
            {renderToolButton('BX', 'Section Box', 'BX', <Scissors size={20} className="text-[#ec4899]" />, () =>
              toggleSectionBox()
            )}
          </div>
        )}

        {activeRibbonTab === 'Manage' && (
          <div className="flex items-center space-x-2">
            <button
              onClick={() => setGeoreferenceModalOpen(true)}
              className="flex flex-col items-center justify-center px-3 py-1.5 rounded hover:bg-[#333333] border border-transparent hover:border-[#444444]"
              title="IFC4 Georeferencing &amp; Map Conversion"
            >
              <Globe size={20} className="text-[#38bdf8] mb-1" />
              <span className="text-[11px] font-medium">Georeferencing</span>
            </button>
            <button
              onClick={() => exportIfc()}
              className="flex flex-col items-center justify-center px-3 py-1.5 rounded hover:bg-[#333333] border border-transparent hover:border-[#444444]"
              title="Export buildingSMART IFC4 STEP file"
            >
              <Download size={20} className="text-[#10b981] mb-1" />
              <span className="text-[11px] font-medium">Export IFC4</span>
            </button>
          </div>
        )}
      </div>

      {/* Hidden Native File Input for Opening Local IFC Files */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".ifc,.stp,.step"
        className="hidden"
        onChange={handleFileChange}
      />
    </div>
  );
};
