import React, { useRef, useEffect } from 'react';
import {
  ChevronDown,
  Layers,
  Box,
  FileSpreadsheet,
  Download,
  FolderOpen,
  Save,
  RotateCcw,
  RotateCw,
  Home,
  Scissors,
  Check,
  X,
  Sparkles,
  PenTool,
  Square,
  Trash2,
  Lock,
  Equal,
  Globe,
  SlidersHorizontal,
  Building2,
  Eye,
  Mountain,
  Trees,
  Car,
  Compass,
  FileText,
  Split,
  Tag,
  Maximize2,
  Grid,
} from 'lucide-react';
import { useBimStore } from '../../store/useBimStore';
import { ActiveTool } from '../../types/bim';
import { isToolImplemented } from '../../interaction/toolCaptions';
import {
  IconModify,
  IconProperties,
  IconWall,
  IconDoor,
  IconWindow,
  IconComponent,
  IconColumn,
  IconRoof,
  IconCeiling,
  IconFloor,
  IconCurtainSystem,
  IconCurtainGrid,
  IconMullion,
  IconRailing,
  IconRamp,
  IconStair,
  IconModelText,
  IconModelLine,
  IconModelGroup,
  IconRoom,
  IconRoomSeparator,
  IconTagRoom,
  IconOpening,
  IconLevel,
  IconGrid as IconCADGrid,
  IconWorkPlane,
  IconManageLinks,
  IconLinkIFC,
  IconLinkCAD,
  IconLinkTopo,
  IconDecal,
  IconDocPDF,
  IconDocImage,
  IconImportCAD,
  IconLoadFamily,
  IconLoadCloud,
  IconDimAligned,
  IconDimLinear,
  IconDimAngular,
  IconDimRadial,
  IconSpotElevation,
  IconDetailLine,
  IconRegion,
  IconRevisionCloud,
  IconInsulation,
  IconText,
  IconCheckSpelling,
  IconFindReplace,
  IconTagCategory,
  IconColorLegend,
  IconKeynote,
  IconSymbol,
  IconStairPath,
  IconAlign,
  IconOffset,
  IconMirrorPick,
  IconMirrorDraw,
  IconSplitElement,
  IconPin,
  IconUnpin,
  IconMove,
  IconCopyTool,
  IconRotate,
  IconTrimCorner,
  IconTrimSingle,
  IconTrimMultiple,
  IconDeleteRed,
  IconMeasure,
  IconCreateSimilar,
  IconCreateGroup,
  IconHouse3D,
  IconMaterials,
  IconObjectStyles,
  IconSnaps,
  IconProjectInfo,
  IconParametersService,
  IconLocation,
  IconDesignOptions,
  IconPhases,
  IconShowMass,
  IconInPlaceMass,
  IconPlaceMass,
  IconToposolid,
  IconContextualData,
  IconSiteComponent,
  IconParkingComponent,
  IconPropertyLine,
  IconLabelContours,
} from '../icons/RevitIcons';

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
    setEditTypeModalOpen,
    activeViewId,
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
    deleteSelectedSketchLine,
    handleDeleteKey,
    selectedGuid,
    meshes,
    views,
    sheets,
  } = useBimStore();

  const selectedMesh = meshes.find((m) => m.guid === selectedGuid);
  const isSelectedSlab =
    selectedMesh?.ifc_class === 'IfcSlab' && !selectedMesh?.name.toLowerCase().includes('roof');
  const isSelectedRoof =
    selectedMesh?.ifc_class === 'IfcRoof' || selectedMesh?.name.toLowerCase().includes('roof');

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
      if (lower.endsWith('.bimworks') || lower.endsWith('.orlt')) {
        await loadProjectContainer(file);
      } else {
        await loadIfcFile(file);
      }
      e.target.value = '';
    }
  };

  // Exactly Revit's 7 architectural tabs requested by user
  const tabs = [
    'Architecture',
    'Insert',
    'Annotate',
    'Massing&Site',
    'View',
    'Manage',
    'Modify',
  ] as const;

  /** Tool implementation gate for UI-P0 parity */
  const notYet = (tool: ActiveTool) =>
    isToolImplemented(tool) ? undefined : 'Not available yet — see the UI plan (UI-P2)';

  /** Renders a large Revit-style ribbon button with icon on top, label on bottom */
  const renderToolButton = (
    tool: ActiveTool,
    label: string,
    shortcut: string,
    icon: React.ReactNode,
    onClick?: () => void,
    disabledReason?: string,
    isSplit?: boolean
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
        className={`flex flex-col items-center justify-center px-1.5 py-1 rounded transition-all group relative border min-w-[50px] h-[58px] select-none ${
          disabled
            ? 'border-transparent text-[#94a3b8] cursor-not-allowed opacity-50'
            : isActive
            ? 'bg-[#cce8ff] border-[#007acc] text-[#094771] shadow-xs'
            : 'border-transparent hover:bg-[#e0f2fe] hover:border-[#bae6fd] text-[#1e293b]'
        }`}
        title={disabled ? `${label} — ${disabledReason}` : `${label} (${shortcut})`}
      >
        <div className="w-6 h-6 flex items-center justify-center mb-0.5 group-hover:scale-105 transition-transform">
          {icon}
        </div>
        <span className="text-[11px] font-medium leading-none text-center tracking-tight truncate max-w-[62px]">
          {label}
        </span>
        {isSplit && <ChevronDown size={10} className="text-[#64748b] mt-0.5" />}
        {shortcut && (
          <span className="absolute top-0.5 right-1 text-[8px] font-mono text-[#94a3b8] group-hover:text-[#0284c7]">
            {shortcut}
          </span>
        )}
      </button>
    );
  };

  /** Renders a small stacked Revit tool button (icon left, text right) */
  const renderSmallButton = (
    label: string,
    icon: React.ReactNode,
    onClick?: () => void,
    disabledReason?: string,
    shortcut?: string
  ) => {
    const disabled = Boolean(disabledReason);
    return (
      <button
        onClick={() => {
          if (disabled) return;
          if (onClick) onClick();
        }}
        disabled={disabled}
        className={`flex items-center space-x-1.5 px-1.5 py-0.5 rounded transition-colors text-left text-[11px] border border-transparent w-full select-none ${
          disabled
            ? 'text-[#94a3b8] cursor-not-allowed opacity-50'
            : 'hover:bg-[#e0f2fe] hover:border-[#bae6fd] text-[#1e293b]'
        }`}
        title={
          disabled
            ? `${label} — ${disabledReason}`
            : shortcut
            ? `${label} (${shortcut})`
            : label
        }
      >
        <div className="w-3.5 h-3.5 flex items-center justify-center shrink-0">{icon}</div>
        <span className="truncate leading-tight text-[11px] font-medium">{label}</span>
      </button>
    );
  };

  /** Renders a dummy architectural tool button */
  const renderDummyTool = (
    label: string,
    shortcut: string,
    icon: React.ReactNode,
    isSplit = false
  ) => {
    return renderToolButton(
      'select',
      label,
      shortcut,
      icon,
      undefined,
      'Revit architectural design feature',
      isSplit
    );
  };

  /** Container for each Revit Ribbon panel with a bottom footer title */
  const RibbonPanel: React.FC<{
    title: string;
    children: React.ReactNode;
  }> = ({ title, children }) => (
    <div className="flex flex-col justify-between border-r border-[#d1d5db] px-2 h-full shrink-0">
      <div className="flex items-center space-x-1 flex-1 py-0.5">{children}</div>
      <div className="text-[10px] text-[#64748b] font-medium text-center py-0.5 border-t border-[#e5e7eb] tracking-tight select-none">
        {title}
      </div>
    </div>
  );

  return (
    <div className="flex flex-col bg-[#f3f4f6] border-b border-[#d1d5db] select-none text-[#1e293b] shadow-xs z-30 font-sans">
      {/* 1. Top Quick Access Toolbar & App Bar */}
      <div className="flex items-center justify-between px-3 py-1 bg-[#ffffff] border-b border-[#e5e7eb] text-xs">
        <div className="flex items-center space-x-3">
          <div className="flex items-center space-x-1.5">
            <div className="w-5 h-5 bg-[#007acc] rounded flex items-center justify-center font-bold text-[11px] text-white shadow-xs tracking-tighter">
              R
            </div>
            <span className="font-bold text-[#1e293b] tracking-wide text-xs">BIMWorks</span>
            <span className="text-[10px] text-[#64748b] bg-[#f1f5f9] px-1.5 py-0.5 rounded border border-[#cbd5e1] font-mono">
              IFC4
            </span>
          </div>

          <div className="h-4 w-[1px] bg-[#cbd5e1]" />

          {/* Quick Access Icons */}
          <div className="flex items-center space-x-1">
            <button
              onClick={handleOpenFileClick}
              className="p-1 hover:bg-[#e2e8f0] rounded text-[#475569] hover:text-[#0f172a]"
              title="Open Project (.bimworks) or IFC File (.ifc) - Ctrl+O"
            >
              <FolderOpen size={14} className={isLoadingFile ? 'text-[#0284c7] animate-pulse' : ''} />
            </button>
            <button
              onClick={() => exportProjectContainer()}
              className="p-1 hover:bg-[#e2e8f0] rounded text-[#475569] hover:text-[#0f172a]"
              title="Save Project Container (.bimworks)"
            >
              <Save size={14} className="text-[#0284c7]" />
            </button>
            <button
              onClick={() => exportIfc()}
              className="p-1 hover:bg-[#e2e8f0] rounded text-[#475569] hover:text-[#0f172a]"
              title="Export Standard IFC4 (.ifc)"
            >
              <Download size={14} />
            </button>
            <button
              onClick={() => undoTransaction()}
              className="p-1 hover:bg-[#e2e8f0] rounded text-[#475569] hover:text-[#0f172a]"
              title="Undo Transaction (Ctrl+Z)"
            >
              <RotateCcw size={14} />
            </button>
            <button
              onClick={() => redoTransaction()}
              className="p-1 hover:bg-[#e2e8f0] rounded text-[#475569] hover:text-[#0f172a]"
              title="Redo Transaction (Ctrl+Y)"
            >
              <RotateCw size={14} />
            </button>
            <div className="h-3 w-[1px] bg-[#cbd5e1] mx-1" />
            <button
              onClick={() => setActiveViewId('view-3d')}
              className="p-1 hover:bg-[#e2e8f0] rounded text-[#475569] hover:text-[#0f172a]"
              title='Default 3D View ("3D")'
            >
              <Home size={14} />
            </button>
            <button
              onClick={() => toggleSectionBox()}
              className={`p-1 rounded ${
                sectionBox.enabled
                  ? 'bg-[#cce8ff] text-[#0284c7]'
                  : 'hover:bg-[#e2e8f0] text-[#475569] hover:text-[#0f172a]'
              }`}
              title="Real-Time Section Box (BX)"
            >
              <Scissors size={14} />
            </button>
          </div>
        </div>

        {/* Middle Project Title */}
        <div className="text-[11px] text-[#64748b] font-medium hidden md:block">
          Autodesk Revit Architectural Parity — BIMWorks 2026
        </div>

        {/* Right Status / Hotkey Buffer Indicator */}
        <div className="flex items-center space-x-2">
          {keyBuffer && (
            <div className="bg-[#0284c7] text-white px-2 py-0.5 rounded text-[10px] font-mono font-bold animate-pulse">
              HOTKEY: [{keyBuffer}_]
            </div>
          )}
          <span className="text-[10px] text-[#64748b] font-mono">Architecture</span>
        </div>
      </div>

      {/* 2. Ribbon Tab Strip */}
      <div className="flex items-center px-2 pt-1 border-b border-[#d1d5db] space-x-0.5 bg-[#f3f4f6]">
        {/* Blue Revit File Tab */}
        <button
          onClick={handleOpenFileClick}
          className="px-3.5 py-1 text-xs font-semibold bg-[#007acc] hover:bg-[#0062a3] text-white rounded-t shadow-xs transition-colors mr-1"
          title="File Menu (Open, Save, Export)"
        >
          File
        </button>

        {tabs.map((tab) => (
          <button
            key={tab}
            onClick={() => {
              if (sketchSession) return;
              setActiveRibbonTab(tab);
            }}
            className={`px-3 py-1 text-xs font-medium rounded-t border-t border-l border-r transition-colors select-none ${
              !sketchSession && activeRibbonTab === tab
                ? 'bg-[#ffffff] border-[#d1d5db] text-[#0f172a] font-bold shadow-xs'
                : 'border-transparent text-[#475569] hover:text-[#0f172a] hover:bg-[#e5e7eb]'
            } ${sketchSession ? 'opacity-40 cursor-not-allowed' : ''}`}
          >
            {tab}
          </button>
        ))}

        {/* Revit Green Contextual Tab when in Sketch Mode */}
        {sketchSession && (
          <div className="flex items-center space-x-1.5 px-3 py-1 bg-[#15803d] text-white text-xs font-semibold rounded-t border-t border-l border-r border-[#166534] shadow-xs ml-2">
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

      {/* 3. Ribbon Panels Content */}
      <div className="flex items-stretch px-2 py-1 min-h-[76px] bg-[#ffffff] overflow-x-auto">
        {/* SKETCH MODE CONTEXTUAL RIBBON PANELS */}
        {sketchSession ? (
          <>
            <RibbonPanel title="Mode">
              <button
                onClick={() => finishSketchMode()}
                className="flex flex-col items-center justify-center px-4 py-1.5 bg-[#16a34a] hover:bg-[#15803d] border border-[#166534] text-white rounded shadow-sm transition-all group"
                title="Finish Edit Mode (Enter)"
              >
                <Check size={18} className="text-white stroke-[3]" />
                <span className="text-[11px] font-bold mt-0.5 leading-none">Finish</span>
                <span className="text-[8px] text-[#bbf7d0] font-mono leading-none mt-0.5">Enter</span>
              </button>
              <button
                onClick={() => cancelSketchMode()}
                className="flex flex-col items-center justify-center px-4 py-1.5 bg-[#dc2626] hover:bg-[#b91c1c] border border-[#991b1b] text-white rounded shadow-sm transition-all group"
                title="Cancel Edit Mode (Esc)"
              >
                <X size={18} className="text-white stroke-[3]" />
                <span className="text-[11px] font-bold mt-0.5 leading-none">Cancel</span>
                <span className="text-[8px] text-[#fecaca] font-mono leading-none mt-0.5">Esc</span>
              </button>
            </RibbonPanel>

            <RibbonPanel title="Draw">
              <button
                onClick={() => setSketchDrawTool('line')}
                className={`flex flex-col items-center justify-center px-3 py-1.5 rounded transition-all border ${
                  sketchSession.drawTool === 'line'
                    ? 'bg-[#cce8ff] border-[#007acc] text-[#094771] shadow-xs'
                    : 'border-transparent hover:bg-[#e0f2fe] text-[#1e293b]'
                }`}
                title="Line Tool (Draw straight boundary edges)"
              >
                <PenTool size={18} className="text-[#0284c7] mb-0.5" />
                <span className="text-[10px] font-medium leading-none">Line</span>
              </button>
              <button
                onClick={() => setSketchDrawTool('rectangle')}
                className={`flex flex-col items-center justify-center px-3 py-1.5 rounded transition-all border ${
                  sketchSession.drawTool === 'rectangle'
                    ? 'bg-[#cce8ff] border-[#007acc] text-[#094771] shadow-xs'
                    : 'border-transparent hover:bg-[#e0f2fe] text-[#1e293b]'
                }`}
                title="Rectangle Tool (Draw rectangular boundary)"
              >
                <Square size={18} className="text-[#9333ea] mb-0.5" />
                <span className="text-[10px] font-medium leading-none">Rectangle</span>
              </button>
            </RibbonPanel>

            <RibbonPanel title="Modify">
              <button
                onClick={() => deleteSelectedSketchLine()}
                disabled={sketchSession.selectedLineId === null}
                className="flex flex-col items-center justify-center px-3 py-1.5 rounded border border-transparent hover:bg-[#fee2e2] disabled:opacity-40 text-[#dc2626]"
                title="Delete Selected Boundary Segment (Delete)"
              >
                <Trash2 size={18} className="text-[#dc2626] mb-0.5" />
                <span className="text-[10px] font-medium leading-none">Delete Line</span>
              </button>
            </RibbonPanel>
          </>
        ) : activeRibbonTab === 'Architecture' ? (
          /* ARCHITECTURE TAB (Image 3) */
          <>
            {/* Select Panel */}
            <RibbonPanel title="Select">
              {renderToolButton('select', 'Modify', 'MD', <IconModify size={22} />)}
            </RibbonPanel>

            {/* Build Panel */}
            <RibbonPanel title="Build">
              {renderToolButton('WA', 'Wall', 'WA', <IconWall size={22} />, undefined, undefined, true)}
              {renderToolButton('DR', 'Door', 'DR', <IconDoor size={22} />)}
              {renderToolButton('WN', 'Window', 'WN', <IconWindow size={22} />)}
              {renderDummyTool('Component', 'CM', <IconComponent size={22} />, true)}
              {renderDummyTool('Column', 'CL', <IconColumn size={22} />, true)}
              {renderToolButton('RF', 'Roof', 'RF', <IconRoof size={22} />, () =>
                startSketchMode('roof'), undefined, true
              )}
              {renderToolButton('SB', 'Floor', 'SB', <IconFloor size={22} />, () =>
                startSketchMode('floor'), undefined, true
              )}
              {renderDummyTool('Curtain System', 'CS', <IconCurtainSystem size={22} />)}
              {renderDummyTool('Curtain Grid', 'CG', <IconCurtainGrid size={22} />)}
              {renderDummyTool('Mullion', 'ML', <IconMullion size={22} />)}

              {/* Chain checkbox for UI-P0 test suite */}
              <label
                className="flex flex-col items-center justify-center px-1.5 py-1 rounded border border-transparent hover:border-[#cbd5e1] cursor-pointer text-[#475569]"
                title="Keep placement tool armed after each element (Revit behavior)."
              >
                <input
                  type="checkbox"
                  checked={chainTools}
                  onChange={(e) => setChainTools(e.target.checked)}
                  className="mb-1 rounded border-[#cbd5e1] text-[#007acc] focus:ring-0"
                />
                <span className="text-[10px] font-medium leading-none">Chain</span>
              </label>
            </RibbonPanel>

            {/* Circulation Panel */}
            <RibbonPanel title="Circulation">
              {renderDummyTool('Railing', 'RA', <IconRailing size={22} />, true)}
              {renderDummyTool('Ramp', 'RP', <IconRamp size={22} />)}
              {renderDummyTool('Stair', 'ST', <IconStair size={22} />)}
            </RibbonPanel>

            {/* Model Panel */}
            <RibbonPanel title="Model">
              <div className="flex flex-col justify-center space-y-0.5">
                {renderSmallButton('Model Text', <IconModelText size={14} />, undefined, '3D Model Text')}
                {renderSmallButton('Model Line', <IconModelLine size={14} />, undefined, 'Model Drafting Line')}
                {renderSmallButton('Model Group', <IconModelGroup size={14} />, undefined, 'Model Group', 'GP')}
              </div>
            </RibbonPanel>

            {/* Room & Area Panel */}
            <RibbonPanel title="Room & Area">
              <div className="flex flex-col justify-center space-y-0.5">
                {renderSmallButton('Room', <IconRoom size={14} />, undefined, 'Room definition', 'RM')}
                {renderSmallButton('Room Separator', <IconRoomSeparator size={14} />, undefined, 'Boundary separator')}
                {renderSmallButton('Tag Room', <IconTagRoom size={14} />, undefined, 'Tag Room', 'RT')}
              </div>
            </RibbonPanel>

            {/* Opening Panel */}
            <RibbonPanel title="Opening">
              <div className="flex flex-col justify-center space-y-0.5">
                {renderSmallButton('By Face', <IconOpening size={14} />, undefined, 'Opening by Face')}
                {renderSmallButton('Shaft', <Box size={14} className="text-[#a855f7]" />, undefined, 'Shaft Opening')}
                {renderSmallButton('Wall Opening', <Scissors size={14} className="text-[#0284c7]" />, undefined, 'Wall Opening')}
              </div>
            </RibbonPanel>

            {/* Datum Panel */}
            <RibbonPanel title="Datum">
              {renderToolButton('LL', 'Level', 'LL', <IconLevel size={22} />, undefined, notYet('LL'))}
              {renderToolButton('GR', 'Grid', 'GR', <IconCADGrid size={22} />, undefined, notYet('GR'))}
            </RibbonPanel>

            {/* Work Plane Panel */}
            <RibbonPanel title="Work Plane">
              <div className="flex flex-col justify-center space-y-0.5">
                {renderSmallButton('Set Work Plane', <IconWorkPlane size={14} />, undefined, 'Set Work Plane', 'PK')}
                {renderSmallButton('Show Plane', <Eye size={14} className="text-[#0284c7]" />, undefined, 'Show Work Plane')}
                {renderSmallButton('Ref Plane', <PenTool size={14} className="text-[#64748b]" />, undefined, 'Reference Plane', 'RP')}
              </div>
            </RibbonPanel>

            {/* Contextual Edit Footprint/Boundary if selected */}
            {(isSelectedSlab || isSelectedRoof) && selectedGuid && (
              <RibbonPanel title="Edit">
                {isSelectedSlab && (
                  <button
                    onClick={() => startSketchMode('floor', selectedGuid)}
                    className="flex flex-col items-center justify-center px-2.5 py-1 bg-[#15803d] hover:bg-[#166534] border border-[#166534] text-white rounded shadow-xs transition-all"
                    title="Edit Floor Boundary (Sketch Mode)"
                  >
                    <PenTool size={16} className="text-[#86efac] mb-0.5" />
                    <span className="text-[10px] font-bold leading-none">Edit Boundary</span>
                  </button>
                )}
                {isSelectedRoof && (
                  <button
                    onClick={() => startSketchMode('roof', selectedGuid)}
                    className="flex flex-col items-center justify-center px-2.5 py-1 bg-[#15803d] hover:bg-[#166534] border border-[#166534] text-white rounded shadow-xs transition-all"
                    title="Edit Roof Footprint (Sketch Mode)"
                  >
                    <PenTool size={16} className="text-[#86efac] mb-0.5" />
                    <span className="text-[10px] font-bold leading-none">Edit Footprint</span>
                  </button>
                )}
              </RibbonPanel>
            )}
          </>
        ) : activeRibbonTab === 'Insert' ? (
          /* INSERT TAB (Image 4 with RED EXCLUSIONS) */
          <>
            {/* Select Panel */}
            <RibbonPanel title="Select">
              {renderToolButton('select', 'Modify', 'MD', <IconModify size={22} />)}
            </RibbonPanel>

            {/* Link Panel */}
            <RibbonPanel title="Link">
              {renderDummyTool('Manage Links', 'ML', <IconManageLinks size={22} />)}
              {/* Excluded: Link Revit */}
              {renderToolButton('select', 'Link IFC', 'IFC', <IconLinkIFC size={22} />, handleOpenFileClick)}
              {renderDummyTool('Link CAD', 'LC', <IconLinkCAD size={22} />)}
              {renderDummyTool('Link Topography', 'LT', <IconLinkTopo size={22} />)}
              {/* Excluded: DWF Markup */}
              {renderDummyTool('Decal', 'DC', <IconDecal size={22} />, true)}
              {/* Excluded: Point Cloud, Coordination Model */}
              <div className="flex flex-col justify-center space-y-0.5 border-l border-[#e5e7eb] pl-1.5">
                {renderSmallButton('Link PDF', <IconDocPDF size={14} />, undefined, 'Link PDF document')}
                {renderSmallButton('Link Image', <IconDocImage size={14} />, undefined, 'Link raster image')}
              </div>
            </RibbonPanel>

            {/* Import Panel */}
            <RibbonPanel title="Import">
              {renderDummyTool('Import CAD', 'IC', <IconImportCAD size={22} />)}
              {/* Excluded: Import gbXML */}
              <div className="flex flex-col justify-center space-y-0.5">
                {renderSmallButton('Import PDF', <IconDocPDF size={14} />, undefined, 'Import PDF vector/raster')}
                {renderSmallButton('Import Image', <IconDocImage size={14} />, undefined, 'Import Image')}
              </div>
            </RibbonPanel>

            {/* Load from Library Panel */}
            <RibbonPanel title="Load from Library">
              {renderDummyTool('Load Family', 'LF', <IconLoadFamily size={22} />)}
              {renderDummyTool('Load Autodesk Family', 'LA', <IconLoadCloud size={22} />)}
              <div className="flex flex-col justify-center space-y-0.5">
                {renderSmallButton('Load as Group', <IconModelGroup size={14} />, undefined, 'Load as Group')}
                {renderSmallButton('Insert from File', <FolderOpen size={14} className="text-[#0284c7]" />, handleOpenFileClick, undefined, 'Insert from File')}
              </div>
              <button
                onClick={() => loadSampleProject()}
                disabled={isLoadingFile}
                className="flex items-center space-x-1.5 px-2.5 py-1.5 bg-[#f1f5f9] hover:bg-[#e2e8f0] border border-[#cbd5e1] rounded text-xs text-[#1e293b] transition-colors cursor-pointer ml-1"
                title="Load built-in IFC4 architectural sample building"
              >
                <Building2 size={15} className="text-[#0284c7]" />
                <span className="font-medium text-[11px]">Sample BIM</span>
              </button>
            </RibbonPanel>
          </>
        ) : activeRibbonTab === 'Annotate' ? (
          /* ANNOTATE TAB (Image 5 with RED EXCLUSIONS) */
          <>
            {/* Select Panel */}
            <RibbonPanel title="Select">
              {renderToolButton('select', 'Modify', 'MD', <IconModify size={22} />)}
            </RibbonPanel>

            {/* Dimension Panel */}
            <RibbonPanel title="Dimension">
              {renderToolButton('DI', 'Aligned', 'DI', <IconDimAligned size={22} />, undefined, notYet('DI'))}
              {renderDummyTool('Linear', 'DL', <IconDimLinear size={22} />)}
              {renderDummyTool('Angular', 'DA', <IconDimAngular size={22} />)}
              {renderDummyTool('Radial', 'DR', <IconDimRadial size={22} />)}
              <div className="flex flex-col justify-center space-y-0.5">
                {renderSmallButton('Diameter', <IconDimRadial size={13} />, undefined, 'Diameter dimension')}
                {renderSmallButton('Spot Elevation', <IconSpotElevation size={13} />, undefined, 'Spot Elevation', 'EL')}
                {renderSmallButton('Spot Coordinate', <Compass size={13} className="text-[#0284c7]" />, undefined, 'Coordinates')}
              </div>
              {/* Equalize South Wall Windows (Required by UI-P0 test gate) */}
              {renderToolButton('EQ', 'Equalize', 'EQ', <Equal size={22} className="text-[#15803d]" />, () =>
                equalizeSouthWallWindows()
              )}
            </RibbonPanel>

            {/* Detail Panel */}
            <RibbonPanel title="Detail">
              {renderToolButton('DL', 'Detail Line', 'DL', <IconDetailLine size={22} />, undefined, notYet('DL'))}
              {renderDummyTool('Region', 'RG', <IconRegion size={22} />, true)}
              <div className="flex flex-col justify-center space-y-0.5">
                {renderSmallButton('Revision Cloud', <IconRevisionCloud size={13} />, undefined, 'Revision Cloud')}
                {renderSmallButton('Insulation', <IconInsulation size={13} />, undefined, 'Insulation Batting')}
              </div>
            </RibbonPanel>

            {/* Text Panel */}
            <RibbonPanel title="Text">
              {renderToolButton('TX', 'Text', 'TX', <IconText size={22} />, undefined, notYet('TX'))}
              <div className="flex flex-col justify-center space-y-0.5">
                {renderSmallButton('Check Spelling', <IconCheckSpelling size={13} />, undefined, 'Check Spelling')}
                {renderSmallButton('Find/Replace', <IconFindReplace size={13} />, undefined, 'Find and Replace')}
              </div>
            </RibbonPanel>

            {/* Tag Panel */}
            <RibbonPanel title="Tag">
              {renderToolButton('TG', 'Tag Category', 'TG', <IconTagCategory size={22} />, undefined, notYet('TG'))}
              {/* Excluded: Beam Annotations, Multi-Rebar */}
              <div className="flex flex-col justify-center space-y-0.5">
                {renderSmallButton('Tag All', <Tag size={13} className="text-[#0284c7]" />, undefined, 'Tag All Not Tagged')}
                {renderSmallButton('Material Tag', <Layers size={13} className="text-[#d97706]" />, undefined, 'Material Tag')}
                {renderSmallButton('Room Tag', <IconTagRoom size={13} />, undefined, 'Room Tag', 'RT')}
              </div>
            </RibbonPanel>

            {/* Keynote Panel */}
            <RibbonPanel title="Keynote">
              {renderDummyTool('Keynote', 'KN', <IconKeynote size={22} />, true)}
            </RibbonPanel>

            {/* Color Fill Panel */}
            {/* Excluded: Duct Legend, Pipe Legend */}
            <RibbonPanel title="Color Fill">
              {renderDummyTool('Color Fill', 'CF', <IconColorLegend size={22} />)}
            </RibbonPanel>

            {/* Symbol Panel */}
            {/* Excluded: Span Direction, Beam, Fabric, Rebar */}
            <RibbonPanel title="Symbol">
              {renderDummyTool('Symbol', 'SY', <IconSymbol size={22} />)}
              <div className="flex flex-col justify-center space-y-0.5">
                {renderSmallButton('Stair Path', <IconStairPath size={13} />, undefined, 'Stair Run Path')}
              </div>
            </RibbonPanel>
          </>
        ) : activeRibbonTab === 'Massing&Site' ? (
          /* MASSING & SITE TAB (Image 2 Parity) */
          <>
            {/* Select Panel */}
            <RibbonPanel title="Select">
              {renderToolButton('select', 'Modify', 'MD', <IconModify size={22} />)}
            </RibbonPanel>

            {/* Conceptual Mass Panel */}
            <RibbonPanel title="Conceptual Mass">
              {renderDummyTool('Show Mass', 'SM', <IconShowMass size={22} />, true)}
              {renderDummyTool('In-Place Mass', 'MP', <IconInPlaceMass size={22} />)}
              {renderDummyTool('Place Mass', 'PM', <IconPlaceMass size={22} />)}
            </RibbonPanel>

            {/* Model by Face Panel */}
            <RibbonPanel title="Model by Face">
              {renderDummyTool('Curtain System', 'CS', <IconCurtainSystem size={22} />)}
              {renderDummyTool('Roof', 'RF', <IconRoof size={22} />)}
              {renderDummyTool('Wall', 'WF', <IconWall size={22} />)}
              {renderDummyTool('Floor', 'FF', <IconFloor size={22} />)}
              {renderDummyTool('Toposolid', 'TS', <IconToposolid size={22} />)}
            </RibbonPanel>

            {/* Model Site Panel */}
            <RibbonPanel title="Model Site">
              {renderDummyTool('Contextual Data', 'CD', <IconContextualData size={22} />)}
              {renderDummyTool('Toposolid', 'TP', <IconToposolid size={22} />, true)}
              {renderDummyTool('Site Component', 'SC', <IconSiteComponent size={22} />)}
              {renderDummyTool('Parking', 'PK', <IconParkingComponent size={22} />)}
              {renderDummyTool('Property Line', 'PL', <IconPropertyLine size={22} />)}
              {renderDummyTool('Label Contours', 'LC', <IconLabelContours size={22} />)}
            </RibbonPanel>
            {/* Excluded: Graded Region / Analysis (Crossed out in Red) */}
          </>
        ) : activeRibbonTab === 'View' ? (
          /* VIEW TAB */
          <>
            <RibbonPanel title="Select">
              {renderToolButton('select', 'Modify', 'MD', <IconModify size={22} />)}
            </RibbonPanel>

            <RibbonPanel title="Create">
              {renderToolButton('select', 'Default 3D', '3D', <IconHouse3D size={22} />, () =>
                setActiveViewId('view-3d')
              )}
              {renderToolButton(
                'select',
                'Floor Plan',
                'L1',
                <IconFloor size={22} />,
                () => firstPlan && setActiveViewId(firstPlan.id),
                firstPlan ? undefined : 'No floor plan in this project'
              )}
              {renderToolButton(
                'SEC',
                'Section',
                'SEC',
                <Scissors size={22} className="text-[#ea580c]" />,
                () => firstSection && setActiveViewId(firstSection.id),
                firstSection ? undefined : 'No section view in this project'
              )}
              {renderToolButton(
                'SHT',
                'Sheet',
                'SHT',
                <FileSpreadsheet size={22} className="text-[#16a34a]" />,
                () => firstSheet && setActiveSheetId(firstSheet.id),
                firstSheet ? undefined : 'No sheet in this project'
              )}
            </RibbonPanel>

            <RibbonPanel title="Graphics">
              {renderToolButton('BX', 'Section Box', 'BX', <Scissors size={22} className="text-[#db2777]" />, () =>
                toggleSectionBox()
              )}
              {renderToolButton('select', 'View Range', 'VR', <SlidersHorizontal size={22} className="text-[#0284c7]" />, () =>
                setViewRangeModalOpen(true)
              )}
            </RibbonPanel>

            <RibbonPanel title="Windows">
              <div className="flex flex-col justify-center space-y-0.5">
                {renderSmallButton('Tile Views', <Grid size={13} className="text-[#0284c7]" />, undefined, 'Tile Views', 'WT')}
                {renderSmallButton('Tab Views', <Square size={13} className="text-[#9333ea]" />, undefined, 'Tab Views', 'TW')}
              </div>
            </RibbonPanel>
          </>
        ) : activeRibbonTab === 'Manage' ? (
          /* MANAGE TAB (Image 1 Parity) */
          <>
            {/* Select Panel */}
            <RibbonPanel title="Select">
              {renderToolButton('select', 'Modify', 'MD', <IconModify size={22} />)}
            </RibbonPanel>

            {/* Settings Panel */}
            <RibbonPanel title="Settings">
              {renderDummyTool('Materials', 'MT', <IconMaterials size={22} />)}
              {renderDummyTool('Object Styles', 'OS', <IconObjectStyles size={22} />)}
              {renderDummyTool('Snaps', 'SN', <IconSnaps size={22} />)}
              {renderDummyTool('Project Info', 'PI', <IconProjectInfo size={22} />)}
              {renderDummyTool('Parameters Service', 'PS', <IconParametersService size={22} />)}

              {/* Stacked Parameters & Units */}
              <div className="flex flex-col justify-center space-y-0.5 border-l border-[#d1d5db] pl-1.5">
                {renderSmallButton('Project Parameters', <FileText size={13} className="text-[#0284c7]" />, undefined, 'Project Parameters')}
                {renderSmallButton('Shared Parameters', <FileText size={13} className="text-[#d97706]" />, undefined, 'Shared Parameters')}
                {renderSmallButton('Global Parameters', <FileText size={13} className="text-[#16a34a]" />, undefined, 'Global Parameters')}
              </div>
              <div className="flex flex-col justify-center space-y-0.5 border-l border-[#e5e7eb] pl-1.5">
                {renderSmallButton('Transfer Standards', <IconCopyTool size={13} />, undefined, 'Transfer Project Standards')}
                {renderSmallButton('Purge Unused', <Trash2 size={13} className="text-[#dc2626]" />, undefined, 'Purge Unused')}
                {renderSmallButton('Project Units', <IconDimLinear size={13} />, undefined, 'Project Units', 'UN')}
              </div>

              {/* Right Settings */}
              <div className="flex flex-col justify-center space-y-0.5 border-l border-[#e5e7eb] pl-1.5">
                {renderSmallButton('Numbering', <FileSpreadsheet size={13} className="text-[#0284c7]" />, undefined, 'Numbering')}
                {/* Excluded in RED: Structural Settings, MEP Settings */}
                {renderSmallButton('Panel Schedule', <FileText size={13} className="text-[#64748b]" />, undefined, 'Panel Schedule Templates')}
                {renderSmallButton('Additional Settings', <SlidersHorizontal size={13} className="text-[#475569]" />, undefined, 'Additional Settings')}
              </div>
            </RibbonPanel>

            {/* Project Location Panel */}
            <RibbonPanel title="Project Location">
              {renderDummyTool('Location', 'LO', <IconLocation size={22} />)}
              <div className="flex flex-col justify-center space-y-0.5">
                {renderSmallButton('Coordinates', <Globe size={13} className="text-[#0284c7]" />, () => setGeoreferenceModalOpen(true), undefined, 'IFC4 Coordinates & CRS')}
                {renderSmallButton('Position', <Compass size={13} className="text-[#eab308]" />, undefined, 'Position')}
              </div>
            </RibbonPanel>

            {/* Design Options Panel */}
            <RibbonPanel title="Design Options">
              {renderDummyTool('Design Options', 'DO', <IconDesignOptions size={22} />)}
              <div className="flex flex-col justify-center space-y-0.5">
                {renderSmallButton('Add to Set', <Square size={13} className="text-[#64748b]" />, undefined, 'Add to Set')}
                {renderSmallButton('Pick to Edit', <PenTool size={13} className="text-[#0284c7]" />, undefined, 'Pick to Edit')}
              </div>
            </RibbonPanel>
            {/* Excluded in RED: Generative Design Panel (Create Study, Explore Outcomes) */}

            {/* Manage Project Panel */}
            <RibbonPanel title="Manage Project">
              {renderDummyTool('Manage Links', 'ML', <IconManageLinks size={22} />)}
              <div className="flex flex-col justify-center space-y-0.5">
                {renderSmallButton('Decal Types', <IconDecal size={13} />, undefined, 'Decal Types')}
                {renderSmallButton('Starting View', <IconHouse3D size={13} />, undefined, 'Starting View')}
              </div>
            </RibbonPanel>

            {/* Phasing Panel */}
            <RibbonPanel title="Phasing">
              {renderDummyTool('Phases', 'PH', <IconPhases size={22} />)}
            </RibbonPanel>

            {/* Selection Panel */}
            <RibbonPanel title="Selection">
              <div className="flex flex-col justify-center space-y-0.5">
                {renderSmallButton('Save', <Save size={13} className="text-[#16a34a]" />, undefined, 'Save Selection')}
                {renderSmallButton('Load', <FolderOpen size={13} className="text-[#0284c7]" />, undefined, 'Load Selection')}
                {renderSmallButton('Edit', <PenTool size={13} className="text-[#d97706]" />, undefined, 'Edit Selection')}
              </div>
            </RibbonPanel>

            {/* Inquiry Panel */}
            <RibbonPanel title="Inquiry">
              <div className="flex flex-col justify-center space-y-0.5">
                {renderSmallButton('Select by ID', <Tag size={13} className="text-[#0284c7]" />, undefined, 'Select Elements by ID')}
                {renderSmallButton('IDs of Selection', <Tag size={13} className="text-[#64748b]" />, undefined, 'IDs of Selection')}
                {renderSmallButton('Warnings', <SlidersHorizontal size={13} className="text-[#eab308]" />, undefined, 'Review Warnings')}
              </div>
            </RibbonPanel>
            {/* Excluded in RED: Extensions (Add-Ins, Macros) and Visual Programming (Dynamo, Dynamo Player) */}

            {/* Project Data & AI Panel */}
            <RibbonPanel title="Project Data &amp; AI">
              <button
                onClick={() => exportProjectContainer()}
                className="flex items-center space-x-1.5 px-3 py-1.5 bg-[#15803d] hover:bg-[#166534] border border-[#166534] rounded text-xs text-white shadow-xs transition-colors cursor-pointer"
                title="Save BIMWorks .bimworks Project Container"
              >
                <Save size={14} className="text-white" />
                <span className="font-medium">Save Project</span>
              </button>
              <button
                onClick={() => exportIfc()}
                className="flex items-center space-x-1.5 px-3 py-1.5 bg-[#f1f5f9] hover:bg-[#e2e8f0] border border-[#cbd5e1] rounded text-xs text-[#1e293b] transition-colors cursor-pointer"
                title="Export Standard IFC4 STEP File (.ifc)"
              >
                <Download size={14} className="text-[#0284c7]" />
                <span className="font-medium">Export IFC</span>
              </button>
              <button
                onClick={() => setPromptBarOpen(true)}
                className="flex items-center space-x-1.5 px-3 py-1.5 bg-[#0284c7] hover:bg-[#0369a1] border border-[#0284c7] rounded text-xs text-white font-medium shadow-xs transition-colors cursor-pointer"
                title="Open Tier-1 AI Prompt Bar (/ or Ctrl+Enter)"
              >
                <Sparkles size={14} className="text-white" />
                <span>AI Prompt Bar</span>
              </button>
            </RibbonPanel>
          </>
        ) : activeRibbonTab === 'Modify' ? (
          /* MODIFY TAB (Image 1) */
          <>
            {/* Select Panel */}
            <RibbonPanel title="Select">
              {renderToolButton('select', 'Modify', 'MD', <IconModify size={22} />)}
            </RibbonPanel>

            {/* Properties Panel */}
            <RibbonPanel title="Properties">
              <button
                onClick={() => setEditTypeModalOpen(true)}
                className="flex flex-col items-center justify-center px-2 py-1 rounded hover:bg-[#e0f2fe] border border-transparent hover:border-[#bae6fd] min-w-[50px] h-[58px]"
                title="Properties Palette &amp; Type Properties"
              >
                <IconProperties size={22} className="mb-0.5" />
                <span className="text-[11px] font-medium leading-none">Properties</span>
              </button>
            </RibbonPanel>

            {/* Clipboard Panel */}
            <RibbonPanel title="Clipboard">
              {renderDummyTool('Paste', 'Ctrl+V', <IconCopyTool size={22} />, true)}
              <div className="flex flex-col justify-center space-y-0.5">
                {renderSmallButton('Cut', <Scissors size={13} className="text-[#dc2626]" />, undefined, 'Cut (Ctrl+X)', 'Ctrl+X')}
                {renderSmallButton('Copy', <IconCopyTool size={13} />, undefined, 'Copy (Ctrl+C)', 'Ctrl+C')}
              </div>
            </RibbonPanel>

            {/* Geometry Panel */}
            <RibbonPanel title="Geometry">
              <div className="flex flex-col justify-center space-y-0.5">
                {renderSmallButton('Cope', <Split size={13} className="text-[#475569]" />, undefined, 'Cope Steel Beam', 'CP')}
                {renderSmallButton('Cut Geometry', <Scissors size={13} className="text-[#0284c7]" />, undefined, 'Cut Geometry')}
                {renderSmallButton('Join Geometry', <Box size={13} className="text-[#16a34a]" />, undefined, 'Join Geometry', 'JJ')}
              </div>
            </RibbonPanel>

            {/* Controls Panel */}
            <RibbonPanel title="Controls">
              {renderDummyTool('Activate', 'AC', <IconPin size={22} />)}
            </RibbonPanel>

            {/* Modify Panel (The Main Modification Grid) */}
            <RibbonPanel title="Modify">
              {/* Row 1 Tools */}
              <div className="grid grid-cols-7 gap-1">
                {/* Align */}
                <button
                  onClick={() => setActiveTool('AL')}
                  className={`p-1.5 rounded border ${
                    activeTool === 'AL' ? 'bg-[#cce8ff] border-[#007acc]' : 'border-transparent hover:bg-[#e0f2fe]'
                  }`}
                  title="Align Elements (AL)"
                >
                  <IconAlign size={18} />
                </button>

                {/* Offset */}
                <button
                  onClick={() => {}}
                  className="p-1.5 rounded border border-transparent hover:bg-[#e0f2fe]"
                  title="Offset (OF)"
                >
                  <IconOffset size={18} />
                </button>

                {/* Mirror Pick */}
                <button
                  onClick={() => {}}
                  className="p-1.5 rounded border border-transparent hover:bg-[#e0f2fe]"
                  title="Mirror - Pick Axis (MM)"
                >
                  <IconMirrorPick size={18} />
                </button>

                {/* Mirror Draw */}
                <button
                  onClick={() => {}}
                  className="p-1.5 rounded border border-transparent hover:bg-[#e0f2fe]"
                  title="Mirror - Draw Axis (DM)"
                >
                  <IconMirrorDraw size={18} />
                </button>

                {/* Split Element */}
                <button
                  onClick={() => setActiveTool('SL')}
                  className={`p-1.5 rounded border ${
                    activeTool === 'SL' ? 'bg-[#cce8ff] border-[#007acc]' : 'border-transparent hover:bg-[#e0f2fe]'
                  }`}
                  title="Split Element (SL)"
                >
                  <IconSplitElement size={18} />
                </button>

                {/* Split with Gap */}
                <button
                  onClick={() => setActiveTool('SO')}
                  className={`p-1.5 rounded border ${
                    activeTool === 'SO' ? 'bg-[#cce8ff] border-[#007acc]' : 'border-transparent hover:bg-[#e0f2fe]'
                  }`}
                  title="Split with Gap (SO)"
                >
                  <IconSplitElement size={18} />
                </button>

                {/* Pin */}
                <button
                  onClick={() => {}}
                  className="p-1.5 rounded border border-transparent hover:bg-[#e0f2fe]"
                  title="Pin (PN)"
                >
                  <IconPin size={18} />
                </button>

                {/* Row 2 Tools */}
                {/* Move */}
                <button
                  onClick={() => {}}
                  className="p-1.5 rounded border border-transparent hover:bg-[#e0f2fe]"
                  title="Move (MV)"
                >
                  <IconMove size={18} />
                </button>

                {/* Copy */}
                <button
                  onClick={() => {}}
                  className="p-1.5 rounded border border-transparent hover:bg-[#e0f2fe]"
                  title="Copy (CO)"
                >
                  <IconCopyTool size={18} />
                </button>

                {/* Rotate */}
                <button
                  onClick={() => {}}
                  className="p-1.5 rounded border border-transparent hover:bg-[#e0f2fe]"
                  title="Rotate (RO)"
                >
                  <IconRotate size={18} />
                </button>

                {/* Trim / Extend Corner */}
                <button
                  onClick={() => setActiveTool('TR')}
                  className={`p-1.5 rounded border ${
                    activeTool === 'TR' ? 'bg-[#cce8ff] border-[#007acc]' : 'border-transparent hover:bg-[#e0f2fe]'
                  }`}
                  title="Trim / Extend to Corner (TR)"
                >
                  <IconTrimCorner size={18} />
                </button>

                {/* Trim Single */}
                <button
                  onClick={() => {}}
                  className="p-1.5 rounded border border-transparent hover:bg-[#e0f2fe]"
                  title="Trim / Extend Single Element"
                >
                  <IconTrimSingle size={18} />
                </button>

                {/* Trim Multiple */}
                <button
                  onClick={() => {}}
                  className="p-1.5 rounded border border-transparent hover:bg-[#e0f2fe]"
                  title="Trim / Extend Multiple Elements"
                >
                  <IconTrimMultiple size={18} />
                </button>

                {/* Delete */}
                <button
                  onClick={() => handleDeleteKey()}
                  className="p-1.5 rounded border border-transparent hover:bg-[#fee2e2] text-[#dc2626]"
                  title="Delete Element (DE / Delete)"
                >
                  <IconDeleteRed size={18} />
                </button>
              </div>

              {/* Contextual Edit Boundary / Footprint */}
              {isSelectedSlab && selectedGuid && (
                <button
                  onClick={() => startSketchMode('floor', selectedGuid)}
                  className="flex flex-col items-center justify-center px-2 py-1 bg-[#15803d] hover:bg-[#166534] border border-[#166534] text-white rounded shadow-xs ml-1"
                  title="Edit Floor Boundary (Sketch Mode)"
                >
                  <PenTool size={16} className="text-[#86efac] mb-0.5" />
                  <span className="text-[10px] font-bold leading-none">Edit Boundary</span>
                </button>
              )}
              {isSelectedRoof && selectedGuid && (
                <button
                  onClick={() => startSketchMode('roof', selectedGuid)}
                  className="flex flex-col items-center justify-center px-2 py-1 bg-[#15803d] hover:bg-[#166534] border border-[#166534] text-white rounded shadow-xs ml-1"
                  title="Edit Roof Footprint (Sketch Mode)"
                >
                  <PenTool size={16} className="text-[#86efac] mb-0.5" />
                  <span className="text-[10px] font-bold leading-none">Edit Footprint</span>
                </button>
              )}
            </RibbonPanel>

            {/* View Panel */}
            <RibbonPanel title="View">
              <div className="flex flex-col justify-center space-y-0.5">
                {renderSmallButton('Reveal Hidden', <Eye size={13} className="text-[#d97706]" />, undefined, 'Reveal Hidden Elements', 'RH')}
                {renderSmallButton('Linework', <PenTool size={13} className="text-[#475569]" />, undefined, 'Linework Tool', 'LW')}
              </div>
            </RibbonPanel>

            {/* Measure Panel */}
            <RibbonPanel title="Measure">
              <div className="flex flex-col justify-center space-y-0.5">
                {renderSmallButton('Between 2 Refs', <IconMeasure size={13} />, undefined, 'Measure Between Two References')}
                {renderSmallButton('Along Element', <IconDimLinear size={13} />, undefined, 'Measure Along an Element')}
              </div>
            </RibbonPanel>

            {/* Create Panel */}
            <RibbonPanel title="Create">
              {renderDummyTool('Create Similar', 'CS', <IconCreateSimilar size={22} />)}
              {renderDummyTool('Create Group', 'GP', <IconCreateGroup size={22} />)}
            </RibbonPanel>
          </>
        ) : null}
      </div>

      {/* 4. Revit Options Bar */}
      <div className="flex items-center px-3 py-1 bg-[#f8fafc] border-t border-[#e2e8f0] text-xs text-[#334155] min-h-[28px] space-x-4">
        {activeTool === 'WA' ? (
          <>
            <span className="font-semibold text-[#0284c7]">Wall Options:</span>
            <div className="flex items-center space-x-1">
              <span className="text-[#64748b] text-[11px]">Height:</span>
              <span className="font-medium text-[11px] bg-[#ffffff] border border-[#cbd5e1] px-1.5 py-0.5 rounded">
                Unconnected (10' 0")
              </span>
            </div>
            <div className="flex items-center space-x-1">
              <span className="text-[#64748b] text-[11px]">Location Line:</span>
              <span className="font-medium text-[11px] bg-[#ffffff] border border-[#cbd5e1] px-1.5 py-0.5 rounded">
                Wall Centerline
              </span>
            </div>
            <label className="flex items-center space-x-1 cursor-pointer">
              <input
                type="checkbox"
                checked={chainTools}
                onChange={(e) => setChainTools(e.target.checked)}
                className="rounded border-[#cbd5e1] text-[#007acc]"
              />
              <span className="text-[11px] font-medium">Chain</span>
            </label>
            <div className="flex items-center space-x-1">
              <span className="text-[#64748b] text-[11px]">Offset:</span>
              <span className="font-mono text-[11px] bg-[#ffffff] border border-[#cbd5e1] px-1.5 py-0.5 rounded">
                0' 0"
              </span>
            </div>
          </>
        ) : activeTool === 'DR' || activeTool === 'WN' ? (
          <>
            <span className="font-semibold text-[#0284c7]">
              {activeTool === 'DR' ? 'Door Placement:' : 'Window Placement:'}
            </span>
            <label className="flex items-center space-x-1 cursor-pointer">
              <input
                type="checkbox"
                checked={chainTools}
                onChange={(e) => setChainTools(e.target.checked)}
                className="rounded border-[#cbd5e1] text-[#007acc]"
              />
              <span className="text-[11px] font-medium">Chain Placement</span>
            </label>
            <span className="text-[11px] text-[#64748b]">Hover over an existing wall to host and click to place.</span>
          </>
        ) : activeTool === 'AL' ? (
          <>
            <span className="font-semibold text-[#0284c7]">Align:</span>
            <label className="flex items-center space-x-1 cursor-pointer">
              <input type="checkbox" className="rounded border-[#cbd5e1] text-[#007acc]" />
              <span className="text-[11px] font-medium">Multiple Alignment</span>
            </label>
            <label className="flex items-center space-x-1 cursor-pointer">
              <input type="checkbox" defaultChecked className="rounded border-[#cbd5e1] text-[#007acc]" />
              <span className="text-[11px] font-medium">Lock</span>
            </label>
            <span className="text-[11px] text-[#64748b]">Select line or element to align to, then select element to align.</span>
          </>
        ) : (
          <div className="flex items-center space-x-2 text-[#64748b] text-[11px]">
            <span className="font-medium text-[#1e293b]">Ready</span>
            <span>• Click an architectural tool above or type a two-letter hotkey (WA, DR, WN, RF, SB, AL)</span>
          </div>
        )}
      </div>

      {/* Hidden file input for opening IFC or BIMWorks containers */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".ifc,.bimworks,.orlt"
        onChange={handleFileChange}
        className="hidden"
      />
    </div>
  );
};
