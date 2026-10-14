import React, { useRef, useEffect } from 'react';
import { AlertCircle, AppWindow, Box, Check, DoorClosed, Download, Equal, Eye, FileSpreadsheet, FileText, FolderOpen, Globe, Grid, Home, Layers, Lock, Maximize2, PenTool, RotateCcw, RotateCw, Ruler, Save, Scissors, Settings, SlidersHorizontal, Sparkles, Square, Tag, Trash2, Upload, X } from 'lucide-react';
import { useBimStore } from '../../store/useBimStore';
import { ActiveTool } from '../../types/bim';
import { isToolImplemented } from '../../interaction/toolCaptions';

export const Ribbon: React.FC = () => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const {
    activeRibbonTab,
    setActiveRibbonTab,
    activeTool,
    setActiveTool,
    toggleSectionBox,
    setViewRangeModalOpen,
    sectionBox,
    exportIfc,
    exportProjectContainer,
    loadSampleProject,
    loadIfcFile,
    loadProjectContainer,
    undoTransaction,
    redoTransaction,
    setPromptBarOpen,
    isLoadingFile,
    setGeoreferenceModalOpen,
    setActiveViewId,
    setActiveSheetId,
    keyBuffer,
    chainTools,
    setChainTools,
    equalizeSouthWallWindows,
    sketchSession,
    startSketchMode,
    cancelSketchMode,
    finishSketchMode,
    setSketchDrawTool,
    setSketchParam,
    deleteSelectedSketchLine,
    selectedGuid,
    meshes,
    views,
    sheets,
  } = useBimStore();

  const selectedMesh = meshes.find((m) => m.guid === selectedGuid);
  const isSelectedSlab = selectedMesh?.ifc_class === 'IfcSlab' && !selectedMesh?.name.toLowerCase().includes('roof');
  const isSelectedRoof = selectedMesh?.ifc_class === 'IfcRoof' || selectedMesh?.name.toLowerCase().includes('roof');

  // UI-P0-14: the View tab's Section/Sheet buttons target real project content
  // rather than fixed prototype panel ids that may not exist.
  const firstPlan = views.find((v) => v.type === 'floor_plan');
  const firstSection = views.find((v) => v.type === 'section' || v.type === 'elevation');
  const firstSheet = sheets[0];

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
      const lower = file.name.toLowerCase();
      // `.bimworks` is the container format; `.orlt` is the legacy pre-rename
      // extension, still accepted so projects saved by the 10-13 prototype load.
      if (lower.endsWith('.bimworks') || lower.endsWith('.orlt')) {
        await loadProjectContainer(file);
      } else {
        await loadIfcFile(file);
      }
      e.target.value = '';
    }
  };

  const tabs = ['Architecture', 'Annotate', 'View', 'Manage'] as const;

  /**
   * UI-P0-14: a tool button whose tool no viewport implements is rendered
   * disabled with the reason, instead of being clickable and then doing nothing
   * while the status bar claims a placement is in progress. UI-P2 replaces this
   * with per-command `isEnabled`/`rejectedViewRules` queries; until then this is
   * the honest minimum.
   */
  const renderToolButton = (
    tool: ActiveTool,
    label: string,
    shortcut: string,
    icon: React.ReactNode,
    onClick?: () => void,
    disabledReason?: string
  ) => {
    const isActive = activeTool === tool;
    const disabled = Boolean(disabledReason);
    return (
      <button
        onClick={() => {
          if (disabled) return;
          if (onClick) onClick();
          else setActiveTool(tool);
        }}
        disabled={disabled}
        aria-disabled={disabled}
        className={`flex flex-col items-center justify-center px-3 py-1.5 rounded transition-all group relative border ${
          disabled
            ? 'border-transparent text-[#5a5a5a] cursor-not-allowed'
            : isActive
            ? 'bg-[#094771] border-[#007acc] text-white shadow-sm'
            : 'border-transparent hover:bg-[#333333] hover:border-[#444444] text-[#cccccc]'
        }`}
        title={disabled ? `${label} — ${disabledReason}` : `${label} (${shortcut})`}
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

  /** A tool that no viewport implements yet. See `TOOL_CAPTIONS`. */
  const notYet = (tool: ActiveTool) =>
    isToolImplemented(tool) ? undefined : 'Not available yet — see the UI plan (UI-P2)';

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
              title="Open Project (.bimworks / .orlt) or IFC File (.ifc, .step) - Ctrl+O"
            >
              <FolderOpen size={14} className={isLoadingFile ? 'text-[#38bdf8] animate-pulse' : ''} />
            </button>
            <button
              onClick={() => exportProjectContainer()}
              className="p-1 hover:bg-[#333333] rounded text-[#cccccc] hover:text-white"
              title="Save Project Container (.bimworks)"
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
            onClick={() => {
              if (sketchSession) return;
              setActiveRibbonTab(tab);
            }}
            className={`px-3 py-1 text-xs font-medium rounded-t border-t border-l border-r transition-colors ${
              !sketchSession && activeRibbonTab === tab
                ? 'bg-[#1e1e1e] border-[#3c3c3c] text-white font-semibold'
                : 'border-transparent text-[#969696] hover:text-[#d4d4d4] hover:bg-[#2d2d2d]'
            } ${sketchSession ? 'opacity-40 cursor-not-allowed' : ''}`}
          >
            {tab}
          </button>
        ))}

        {/* Revit Green Contextual Tab when in Sketch Mode */}
        {sketchSession && (
          <div className="flex items-center space-x-1.5 px-3 py-1 bg-[#107c41] text-white text-xs font-semibold rounded-t border-t border-l border-r border-[#15803d] shadow-sm ml-2">
            <Sparkles size={13} className="text-[#86efac]" />
            <span>
              Modify |{' '}
              {sketchSession.mode === 'roof'
                ? sketchSession.isEditingExisting
                  ? 'Edit Roof Footprint'
                  : 'Create Roof Footprint'
                : sketchSession.isEditingExisting
                ? 'Edit Floor Boundary'
                : 'Create Floor Boundary'}
            </span>
          </div>
        )}
      </div>

      {/* Ribbon Panels Content */}
      <div className="flex items-center px-3 py-2 space-x-6 min-h-[72px] bg-[#1e1e1e] overflow-x-auto">
        {/* SKETCH MODE CONTEXTUAL RIBBON PANELS */}
        {sketchSession ? (
          <>
            {/* Mode Panel (Finish / Cancel) */}
            <div className="flex items-center space-x-2 border-r border-[#333333] pr-5">
              <button
                onClick={() => finishSketchMode()}
                className="flex flex-col items-center justify-center px-4 py-1.5 bg-[#14532d] hover:bg-[#166534] border border-[#22c55e] text-white rounded shadow transition-all group"
                title="Finish Edit Mode (Enter)"
              >
                <Check size={20} className="text-[#4ade80] stroke-[3]" />
                <span className="text-[11px] font-bold mt-0.5 leading-none">Finish</span>
                <span className="text-[9px] text-[#86efac] font-mono leading-none mt-0.5">Enter</span>
              </button>
              <button
                onClick={() => cancelSketchMode()}
                className="flex flex-col items-center justify-center px-4 py-1.5 bg-[#450a0a] hover:bg-[#7f1d1d] border border-[#ef4444] text-white rounded shadow transition-all group"
                title="Cancel Edit Mode (Esc)"
              >
                <X size={20} className="text-[#f87171] stroke-[3]" />
                <span className="text-[11px] font-bold mt-0.5 leading-none">Cancel</span>
                <span className="text-[9px] text-[#fca5a5] font-mono leading-none mt-0.5">Esc</span>
              </button>
            </div>

            {/* Draw Tools Panel */}
            <div className="flex items-center space-x-2 border-r border-[#333333] pr-5">
              <button
                onClick={() => setSketchDrawTool('line')}
                className={`flex flex-col items-center justify-center px-3 py-1.5 rounded transition-all border ${
                  sketchSession.drawTool === 'line'
                    ? 'bg-[#094771] border-[#007acc] text-white shadow-sm'
                    : 'border-transparent hover:bg-[#333333] hover:border-[#444444] text-[#cccccc]'
                }`}
                title="Line Tool (LI) - Draw boundary line segments"
              >
                <PenTool size={20} className="text-[#ec4899] mb-1" />
                <span className="text-[11px] font-medium leading-none">Line</span>
                <span className="text-[9px] font-mono text-[#858585]">LI</span>
              </button>
              <button
                onClick={() => setSketchDrawTool('rectangle')}
                className={`flex flex-col items-center justify-center px-3 py-1.5 rounded transition-all border ${
                  sketchSession.drawTool === 'rectangle'
                    ? 'bg-[#094771] border-[#007acc] text-white shadow-sm'
                    : 'border-transparent hover:bg-[#333333] hover:border-[#444444] text-[#cccccc]'
                }`}
                title="Rectangle Tool (RE) - Draw 4-corner closed boundary"
              >
                <Square size={20} className="text-[#38bdf8] mb-1" />
                <span className="text-[11px] font-medium leading-none">Rectangle</span>
                <span className="text-[9px] font-mono text-[#858585]">RE</span>
              </button>
              <button
                onClick={() => setSketchDrawTool('pick_walls')}
                className={`flex flex-col items-center justify-center px-3 py-1.5 rounded transition-all border ${
                  sketchSession.drawTool === 'pick_walls'
                    ? 'bg-[#094771] border-[#007acc] text-white shadow-sm'
                    : 'border-transparent hover:bg-[#333333] hover:border-[#444444] text-[#cccccc]'
                }`}
                title="Pick Walls (PW) - Pick walls to lock sketch boundary"
              >
                <Box size={20} className="text-[#a855f7] mb-1" />
                <span className="text-[11px] font-medium leading-none">Pick Walls</span>
                <span className="text-[9px] font-mono text-[#858585]">PW</span>
              </button>
            </div>

            {/* Sketch Options Bar */}
            <div className="flex items-center space-x-4 border-r border-[#333333] pr-5 text-xs">
              {sketchSession.mode === 'roof' ? (
                <>
                  <label className="flex items-center space-x-1.5 cursor-pointer bg-[#262626] px-2.5 py-1.5 rounded border border-[#3c3c3c]">
                    <input
                      type="checkbox"
                      checked={sketchSession.defaultDefinesSlope}
                      onChange={(e) => setSketchParam('defaultDefinesSlope', e.target.checked)}
                      className="rounded bg-[#1e1e1e] border-[#555555] text-[#007acc] focus:ring-0"
                    />
                    <span className="font-medium text-white text-[11px]">Defines Slope</span>
                  </label>

                  <div className="flex items-center space-x-1.5 bg-[#262626] px-2.5 py-1 rounded border border-[#3c3c3c]">
                    <span className="text-[#888888] text-[11px]">Slope:</span>
                    <input
                      type="number"
                      step="0.5"
                      value={sketchSession.pitch}
                      onChange={(e) => {
                        const val = parseFloat(e.target.value) || 0;
                        setSketchParam('pitch', val);
                        setSketchParam('defaultSlopeAngle', val);
                      }}
                      className="w-14 bg-[#1e1e1e] border border-[#555555] rounded px-1.5 py-0.5 text-white text-right text-xs"
                    />
                    <span className="text-[#888888] text-[11px]">deg</span>
                  </div>

                  <div className="flex items-center space-x-1.5 bg-[#262626] px-2.5 py-1 rounded border border-[#3c3c3c]">
                    <span className="text-[#888888] text-[11px]">Overhang:</span>
                    <input
                      type="number"
                      step="0.1"
                      value={sketchSession.defaultOverhang}
                      onChange={(e) => setSketchParam('defaultOverhang', parseFloat(e.target.value) || 0)}
                      className="w-14 bg-[#1e1e1e] border border-[#555555] rounded px-1.5 py-0.5 text-white text-right text-xs"
                    />
                    <span className="text-[#888888] text-[11px]">m</span>
                  </div>
                </>
              ) : (
                <>
                  <div className="flex items-center space-x-1.5 bg-[#262626] px-2.5 py-1 rounded border border-[#3c3c3c]">
                    <span className="text-[#888888] text-[11px]">Thickness:</span>
                    <input
                      type="number"
                      step="0.05"
                      value={sketchSession.thickness}
                      onChange={(e) => setSketchParam('thickness', parseFloat(e.target.value) || 0.25)}
                      className="w-14 bg-[#1e1e1e] border border-[#555555] rounded px-1.5 py-0.5 text-white text-right text-xs"
                    />
                    <span className="text-[#888888] text-[11px]">m</span>
                  </div>

                  <div className="flex items-center space-x-1.5 bg-[#262626] px-2.5 py-1 rounded border border-[#3c3c3c]">
                    <span className="text-[#888888] text-[11px]">Elevation:</span>
                    <input
                      type="number"
                      step="0.1"
                      value={sketchSession.elevation}
                      onChange={(e) => setSketchParam('elevation', parseFloat(e.target.value) || 0)}
                      className="w-14 bg-[#1e1e1e] border border-[#555555] rounded px-1.5 py-0.5 text-white text-right text-xs"
                    />
                    <span className="text-[#888888] text-[11px]">m</span>
                  </div>
                </>
              )}

              {sketchSession.selectedLineId && (
                <button
                  onClick={() => deleteSelectedSketchLine()}
                  className="flex items-center space-x-1 px-2.5 py-1.5 bg-[#7f1d1d] hover:bg-[#991b1b] text-white rounded border border-[#ef4444] text-xs transition-colors"
                  title="Delete Selected Line (Del)"
                >
                  <Trash2 size={13} />
                  <span>Delete Line</span>
                </button>
              )}
            </div>

            {/* Validation & Feedback Status */}
            <div className="flex items-center space-x-3">
              <div className="flex items-center space-x-1.5 text-xs text-[#94a3b8] bg-[#1e293b] px-3 py-1.5 rounded border border-[#334155]">
                <span className="w-2 h-2 rounded-full bg-[#ec4899] animate-ping" />
                <span className="font-mono">{sketchSession.lines.length} lines</span>
              </div>

              {sketchSession.validationError && (
                <div className="flex items-center space-x-1.5 px-3 py-1.5 bg-[#7f1d1d]/80 border border-[#ef4444] rounded text-red-200 text-xs shadow animate-bounce">
                  <AlertCircle size={14} className="text-[#f87171] flex-shrink-0" />
                  <span className="font-medium text-[11px]">{sketchSession.validationError}</span>
                </div>
              )}
            </div>
          </>
        ) : activeRibbonTab === 'Architecture' && (
          <>
            {/* Build Panel */}
            <div className="flex items-center space-x-2 border-r border-[#333333] pr-5">
              {renderToolButton('WA', 'Wall', 'WA', <Box size={20} className="text-[#60a5fa]" />)}
              {renderToolButton('DR', 'Door', 'DR', <DoorClosed size={20} className="text-[#f97316]" />)}
              {renderToolButton('WN', 'Window', 'WN', <AppWindow size={20} className="text-[#38bdf8]" />)}
              {renderToolButton('SB', 'Floor', 'SB', <Layers size={20} className="text-[#a855f7]" />, () =>
                startSketchMode('floor')
              )}
              {renderToolButton('RF', 'Roof', 'RF', <Square size={20} className="text-[#ec4899]" />, () =>
                startSketchMode('roof')
              )}

              {/* UI-P0-1: Revit keeps a placement tool armed so N walls come from
                  N+1 clicks. This is the only Options-Bar-style control for now;
                  UI-P3 replaces it with a schema-driven bar per active command. */}
              <label
                className="flex flex-col items-center justify-center px-2 py-1.5 rounded border border-transparent hover:border-[#444444] cursor-pointer text-[#cccccc]"
                title="Keep the placement tool armed after each element, so you can draw several in a row (Revit behaviour)."
              >
                <input
                  type="checkbox"
                  checked={chainTools}
                  onChange={(e) => setChainTools(e.target.checked)}
                  className="mb-1 rounded bg-[#1e1e1e] border-[#555555] text-[#007acc] focus:ring-0"
                />
                <span className="text-[11px] font-medium leading-none">Chain</span>
              </label>
            </div>

            {/* Datum Panel */}
            <div className="flex items-center space-x-2 border-r border-[#333333] pr-5">
              {renderToolButton(
                'GR',
                'Grid',
                'GR',
                <Grid size={20} className="text-[#eab308]" />,
                undefined,
                notYet('GR')
              )}
              {renderToolButton(
                'LL',
                'Level',
                'LL',
                <Maximize2 size={20} className="text-[#10b981]" />,
                undefined,
                notYet('LL')
              )}
            </div>

            {/* Constraints & Modify Panel */}
            <div className="flex items-center space-x-2 border-r border-[#333333] pr-5">
              {renderToolButton('AL', 'Align & Lock', 'AL', <Lock size={20} className="text-[#38bdf8]" />)}
              {/* UI-P0-14: the ribbon button used to arm a tool nothing consumes
                  while the EQ *hotkey* ran the command directly, so the button and
                  the key did different things. Both now run the same action. */}
              {renderToolButton(
                'EQ',
                'Equalize',
                'EQ',
                <Equal size={20} className="text-[#10b981]" />,
                () => equalizeSouthWallWindows()
              )}

              {/* Contextual Edit Boundary / Edit Footprint buttons for selected element */}
              {isSelectedSlab && selectedGuid && (
                <button
                  onClick={() => startSketchMode('floor', selectedGuid)}
                  className="flex flex-col items-center justify-center px-3 py-1.5 bg-[#0e703c] hover:bg-[#15803d] border border-[#22c55e] text-white rounded shadow transition-all group"
                  title="Edit Floor Boundary (Sketch Mode)"
                >
                  <PenTool size={18} className="text-[#86efac] mb-0.5 group-hover:scale-110 transition-transform" />
                  <span className="text-[11px] font-bold leading-none">Edit Boundary</span>
                </button>
              )}
              {isSelectedRoof && selectedGuid && (
                <button
                  onClick={() => startSketchMode('roof', selectedGuid)}
                  className="flex flex-col items-center justify-center px-3 py-1.5 bg-[#0e703c] hover:bg-[#15803d] border border-[#22c55e] text-white rounded shadow transition-all group"
                  title="Edit Roof Footprint (Sketch Mode)"
                >
                  <PenTool size={18} className="text-[#86efac] mb-0.5 group-hover:scale-110 transition-transform" />
                  <span className="text-[11px] font-bold leading-none">Edit Footprint</span>
                </button>
              )}
            </div>

            {/* Project Loading & File Open Panel */}
            <div className="flex items-center space-x-2 border-r border-[#333333] pr-5">
              <button
                onClick={handleOpenFileClick}
                disabled={isLoadingFile}
                className="flex items-center space-x-1.5 px-3 py-2 bg-[#1e293b] hover:bg-[#334155] border border-[#0284c7] rounded text-xs text-white shadow-sm transition-colors cursor-pointer"
                title="Open .bimworks Project Container (or legacy .orlt) or .ifc File (Ctrl+O)"
              >
                <FolderOpen size={15} className="text-[#38bdf8]" />
                <span className="font-medium">{isLoadingFile ? 'Opening...' : 'Open Project / IFC...'}</span>
              </button>
              <button
                onClick={() => exportProjectContainer()}
                className="flex items-center space-x-1.5 px-3 py-2 bg-[#064e3b] hover:bg-[#047857] border border-[#059669] rounded text-xs text-white shadow-sm transition-colors cursor-pointer"
                title="Save BIMWorks .bimworks Project Container"
              >
                <Save size={14} className="text-[#34d399]" />
                <span>Save Project (.bimworks)</span>
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
            {/* UI-P0-14: these four armed a tool neither viewport implements. They
                are shown disabled with the reason rather than pretending to work;
                they return when annotation has a bus command and a viewport path. */}
            {renderToolButton('DI', 'Aligned Dim', 'DI', <Ruler size={20} className="text-[#38bdf8]" />, undefined, notYet('DI'))}
            {renderToolButton('DL', 'Detail Line', 'DL', <PenTool size={20} className="text-[#e2e8f0]" />, undefined, notYet('DL'))}
            {renderToolButton('TG', 'Tag Category', 'TG', <Tag size={20} className="text-[#f59e0b]" />, undefined, notYet('TG'))}
            {renderToolButton('TX', 'Text', 'TX', <FileText size={20} className="text-[#10b981]" />, undefined, notYet('TX'))}
          </div>
        )}

        {activeRibbonTab === 'View' && (
          <div className="flex items-center space-x-2 border-r border-[#333333] pr-5">
            {renderToolButton(
              'select',
              'Default 3D',
              '3D',
              <Home size={20} className="text-[#38bdf8]" />,
              () => setActiveViewId('view-3d')
            )}
            {/* UI-P0-14: these two used to hardcode `view-level-1` / `view-section-1`
                / `sheet-a101`. When those panel ids were absent from the loaded
                project the button did nothing at all, with no explanation. They now
                follow the real project contents and say so when there is nothing
                to open. */}
            {renderToolButton(
              'select',
              'Floor Plan',
              'L1',
              <Layers size={20} className="text-[#a855f7]" />,
              () => firstPlan && setActiveViewId(firstPlan.id),
              firstPlan ? undefined : 'No floor plan in this project'
            )}
            {renderToolButton(
              'SEC',
              'Section',
              'SEC',
              <Scissors size={20} className="text-[#f97316]" />,
              () => firstSection && setActiveViewId(firstSection.id),
              firstSection ? undefined : 'No section view in this project'
            )}
            {renderToolButton(
              'SHT',
              'Sheet',
              'SHT',
              <FileSpreadsheet size={20} className="text-[#10b981]" />,
              () => firstSheet && setActiveSheetId(firstSheet.id),
              firstSheet ? undefined : 'No sheet in this project'
            )}
            {renderToolButton('BX', 'Section Box', 'BX', <Scissors size={20} className="text-[#ec4899]" />, () =>
              toggleSectionBox()
            )}
            {/* The dialog existed but nothing opened it. */}
            {renderToolButton(
              'select',
              'View Range',
              'VR',
              <SlidersHorizontal size={20} className="text-[#38bdf8]" />,
              () => setViewRangeModalOpen(true)
            )}
          </div>
        )}

        {activeRibbonTab === 'Manage' && (
          <div className="flex items-center space-x-2">
            <button
              onClick={() => setGeoreferenceModalOpen(true)}
              className="flex flex-col items-center justify-center px-3 py-1.5 rounded hover:bg-[#333333] border border-transparent hover:border-[#444444]"
              title="IFC4 Georeferencing and Map Conversion"
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

      {/* Hidden Native File Input for Opening BIMWorks Containers or IFC Files */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".bimworks,.orlt,.ifc,.stp,.step"
        className="hidden"
        onChange={handleFileChange}
      />
    </div>
  );
};
