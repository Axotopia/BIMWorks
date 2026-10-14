import { create } from 'zustand';
import {
  ActiveTool,
  BimElement,
  LevelData,
  GridData,
  MeshBufferData,
  Sliced2DData,
  ViewDefinition,
  SheetDefinition,
  TemporaryDimension,
  SheetViewport,
  ParametricConstraint,
  WallJoinState,
  CommandPayload,
  AiPlan,
  TransactionJournalEntry,
  SketchSession,
  SketchLine,
  SketchDrawTool,
} from '../types/bim';
import { UnitSystem } from '../utils/units';

const API_BASE = '/api';

/**
 * P1 — every editing action the UI can perform maps to a typed CommandBus
 * command. This table is the contract the parity audit checks against: a new UI
 * action is not "done" until it appears here and is dispatched via
 * `dispatchTransaction`, which is the store's only mutation entry point.
 *
 * The store is not allowed to call a raw mutation endpoint. Routes such as
 * `/api/wall` still exist for external clients, but they are bus-backed
 * compatibility shims, and the UI does not use them.
 */
export const UI_ACTION_COMMANDS = {
  createWall: 'WallCreate',
  createDoor: 'DoorInsert',
  createWindow: 'WindowInsert',
  createSlab: 'SlabCreate',
  createRoof: 'RoofCreate',
  updateElement: 'ElementUpdate',
  deleteElement: 'DeleteElement',
  translateElement: 'WallMove',
  setWallJoin: 'SetWallJoin',
  createAlignConstraint: 'ConstraintAlign',
  lockDimension: 'ConstraintLockDim',
  equalizeSpan: 'ConstraintEqualize',
  toggleConstraintLock: 'ConstraintLockToggle',
  deleteConstraint: 'ConstraintDelete',
  // P4 sketch commands — the precision editor and direct manipulation both emit
  // these, which is what makes the two skins agree.
  sketchAddCurve: 'SketchCurveAdd',
  sketchMoveVertex: 'SketchCurveMoveVertex',
  sketchMoveEdge: 'SketchCurveMoveEdge',
  sketchSetSlope: 'SketchCurveSetSlope',
  // P3 modify tools
  copyElement: 'ElementCopy',
  rotateElement: 'ElementRotate',
  offsetElement: 'ElementOffset',
  trimExtendWall: 'WallTrimExtend',
  splitWall: 'WallSplit',
  moveLevel: 'LevelMove',
} as const;

export type UiAction = keyof typeof UI_ACTION_COMMANDS;

/**
 * The engine's internal unit is decimal feet (spec §11.3), so command parameters
 * are feet and no conversion happens here. Only explicitly metric prompt input
 * ("3000 mm", "3 m") is normalised.
 */
const MM_PER_FOOT = 304.8;
const M_PER_FOOT = 0.3048;

const WALL_CLASSES = ['IfcWallStandardCase', 'IfcWall'];

/**
 * Chooses the wall that should host a planned door/window: the current
 * selection when it is a wall, otherwise the first wall in the model.
 * Reads the real element record, so it returns null when no wall exists yet.
 */
function pickHostWall(
  elements: Record<string, BimElement>,
  selectedGuid: string | null
): string | null {
  const wallGuids = Object.keys(elements).filter((g) => WALL_CLASSES.includes(elements[g].ifc_class));
  if (selectedGuid && wallGuids.includes(selectedGuid)) return selectedGuid;
  return wallGuids[0] ?? null;
}

/**
 * Resolves an offset-along-wall for a planned hosted element.
 *
 * An explicit "at 10 feet" / "10'" / "3000 mm" in the prompt wins; otherwise the
 * element is placed at the wall's centre (doors) or near its start (windows).
 * The result is always clamped so the opening fits inside the wall — previously
 * a fixed 3 m offset was emitted, which silently hangs the door past the end of
 * any wall shorter than that. Requires the host's real baseline length.
 */
function planHostedOffset(
  text: string,
  host: BimElement | undefined,
  elementWidth: number,
  fallback: 'centered' | 'start'
): number {
  const wallLength = typeof host?.length === 'number' && host.length > 0 ? host.length : null;
  const maxOffset = wallLength !== null ? Math.max(0, wallLength - elementWidth) : null;
  const preferred = fallback === 'centered' && maxOffset !== null ? maxOffset / 2 : 0;

  // An explicit offset phrase: "at 10 feet", "offset 3m", "3000 mm from the
  // start". Deliberately NOT a bare number: "36x84 door" and "36 inch door" are
  // sizes, and treating their digits as a position parks the door at nonsense
  // offsets. Without a phrase the fallback placement is used instead.
  const atMatch = text.match(
    /(?:at|offset|distance|position)\s*(\d+(?:\.\d+)?)\s*(mm|millimet\w*|ft|feet|foot|'|m|met\w*)?/
  ) ?? text.match(
    /(\d+(?:\.\d+)?)\s*(mm|millimet\w*|ft|feet|foot|'|m|met\w*)\s+(?:from|along)\b/
  );

  let offset = preferred;
  if (atMatch) {
    const value = parseFloat(atMatch[1]);
    const unit = (atMatch[2] || (value > 100 ? 'mm' : 'ft')).toLowerCase();
    if (Number.isFinite(value)) {
      if (unit.startsWith('mm') || unit.startsWith('millimet')) offset = value / MM_PER_FOOT;
      else if (unit === 'm' || unit.startsWith('met')) offset = value / M_PER_FOOT;
      else offset = value;  // feet: already the engine's unit
    }
  }

  if (!Number.isFinite(offset) || offset < 0) offset = 0;
  if (maxOffset !== null) offset = Math.min(offset, maxOffset);
  return offset;
}

/**
 * Validates that lines form a connected closed loop (Revit CurveLoop topology)
 * and returns the ordered 2D polygon vertices.
 */
function extractPolygonFromLines(lines: SketchLine[]): { polygon: [number, number][] | null; error: string | null } {
  if (lines.length < 3) {
    return { polygon: null, error: 'Sketch requires at least 3 connected lines to form a closed boundary.' };
  }

  const tol = 0.5; // 6in endpoint snap tolerance (internal unit: feet)
  const dist = (p1: [number, number], p2: [number, number]) => Math.hypot(p1[0] - p2[0], p1[1] - p2[1]);

  const unused = new Set(lines.map((_, i) => i));
  const poly: [number, number][] = [];

  unused.delete(0);
  let currentStart = lines[0].start;
  let currentEnd = lines[0].end;
  poly.push(currentStart);

  const loopStart = currentStart;

  while (unused.size > 0) {
    let nextIdx = -1;
    let nextReversed = false;

    for (const idx of unused) {
      const l = lines[idx];
      if (dist(l.start, currentEnd) <= tol) {
        nextIdx = idx;
        nextReversed = false;
        break;
      } else if (dist(l.end, currentEnd) <= tol) {
        nextIdx = idx;
        nextReversed = true;
        break;
      }
    }

    if (nextIdx === -1) {
      return {
        polygon: null,
        error: `Open boundary detected: segment at (${currentEnd[0].toFixed(1)}m, ${currentEnd[1].toFixed(1)}m) does not connect to another line. All magenta lines must form a continuous closed loop.`,
      };
    }

    unused.delete(nextIdx);
    const nextLine = lines[nextIdx];
    if (!nextReversed) {
      poly.push(nextLine.start);
      currentEnd = nextLine.end;
    } else {
      poly.push(nextLine.end);
      currentEnd = nextLine.start;
    }
  }

  if (dist(currentEnd, loopStart) > tol) {
    return {
      polygon: null,
      error: `Boundary loop is not closed (gap between start and end is ${(dist(currentEnd, loopStart) * 100).toFixed(0)}cm). Close the loop by snapping to the starting point.`,
    };
  }

  return { polygon: poly, error: null };
}

interface BimStoreState {
  // Navigation & Tools
  activeRibbonTab: 'Architecture' | 'Annotate' | 'View' | 'Manage' | 'Modify';
  activeTool: ActiveTool;
  keyBuffer: string;
  keyBufferTimeout: any;

  // Views & Sheets
  views: ViewDefinition[];
  activeViewId: string;
  sheets: SheetDefinition[];
  activeSheetId: string;

  // Model Data
  projectName: string;
  levels: LevelData[];
  elements: Record<string, BimElement>;
  meshes: MeshBufferData[];
  grids: GridData[];
  sliced2D: Sliced2DData | null;

  // 1D/2D Parametric Constraints
  constraints: ParametricConstraint[];
  alignPickState: { step: 'pick_ref' | 'pick_target' | null; refGuid: string | null };

  // Selection & Properties
  selectedGuid: string | null;
  hoveredGuid: string | null;

  // Revit Spatial & Visibility Controls
  sectionBox: {
    enabled: boolean;
    min: [number, number, number];
    max: [number, number, number];
  };
  hiddenGuids: string[];
  isolatedGuids: string[];
  tempDimension: TemporaryDimension | null;

  // Georeferencing
  georeference: {
    projected_crs: string;
    eastings: number;
    northings: number;
    elevation: number;
    true_north: number;
    scale: number;
  };

  // Modals
  isGeoreferenceModalOpen: boolean;
  isEditTypeModalOpen: boolean;
  isViewRangeModalOpen: boolean;
  /** Legal notice modal (LEGAL.md §1–§5, spec §13). */
  isLegalModalOpen: boolean;

  // File Loading & Status
  isLoadingFile: boolean;
  statusMessage: string;
  setStatusMessage: (msg: string) => void;

  // Status Bar
  activeScale: string;
  activeDetailLevel: 'coarse' | 'medium' | 'fine';
  activeVisualStyle: 'wireframe' | 'hidden_line' | 'consistent_colors';

  // Actions
  setActiveRibbonTab: (tab: BimStoreState['activeRibbonTab']) => void;
  setActiveTool: (tool: ActiveTool) => void;
  handleKeyStroke: (key: string) => void;
  clearKeyBuffer: () => void;

  setActiveViewId: (id: string) => void;
  setActiveSheetId: (id: string) => void;
  setSelectedGuid: (guid: string | null) => void;
  setHoveredGuid: (guid: string | null) => void;

  toggleSectionBox: () => void;
  setSectionBoxBounds: (min: [number, number, number], max: [number, number, number]) => void;

  tempHideSelected: () => void;
  tempIsolateSelected: () => void;
  resetTempVisibility: () => void;

  setTempDimension: (dim: TemporaryDimension | null) => void;
  applyTemporaryDimensionChange: (newValue: number) => Promise<void>;

  setScale: (scale: string) => void;
  setDetailLevel: (detail: 'coarse' | 'medium' | 'fine') => void;
  setVisualStyle: (style: 'wireframe' | 'hidden_line' | 'consistent_colors') => void;

  setGeoreferenceModalOpen: (open: boolean) => void;
  setEditTypeModalOpen: (open: boolean) => void;
  setViewRangeModalOpen: (open: boolean) => void;
  setLegalModalOpen: (open: boolean) => void;

  // 1D/2D Parametric Constraint Actions
  fetchConstraints: () => Promise<void>;
  createAlignConstraint: (refGuid: string, targetGuid: string, axis?: 'x' | 'y', lock?: boolean) => Promise<void>;
  toggleConstraintLock: (constraintId: string, isLocked: boolean) => Promise<void>;
  lockDimension: (guidA: string, guidB: string, distance?: number, axis?: 'x' | 'y') => Promise<void>;
  equalizeSpan: (spanStartGuid: string, spanEndGuid: string, interiorGuids: string[], axis?: 'x' | 'y') => Promise<void>;
  setAlignPickState: (state: { step: 'pick_ref' | 'pick_target' | null; refGuid: string | null }) => void;
  deleteConstraint: (constraintId: string) => Promise<void>;
  equalizeSouthWallWindows: () => Promise<void>;

  // API Async Actions
  fetchProjectState: () => Promise<void>;
  fetchGeometry: () => Promise<void>;
  fetch2DSlice: (cutElevation?: number) => Promise<void>;
  loadSampleProject: () => Promise<void>;
  loadIfcContent: (content: string, filename?: string) => Promise<boolean>;
  loadIfcFile: (file: File) => Promise<boolean>;
  createWall: (start: [number, number, number], end: [number, number, number], name?: string) => Promise<void>;
  createDoor: (hostWallGuid: string, offset: number, name?: string) => Promise<void>;
  createWindow: (hostWallGuid: string, offset: number, name?: string) => Promise<void>;
  createRoof: (polygon: [number, number][], thickness?: number, elevation?: number, pitch_degrees?: number, name?: string) => Promise<void>;
  createSlab: (polygon: [number, number][], thickness?: number, elevation?: number, name?: string) => Promise<void>;
  updateElement: (guid: string, updates: Partial<BimElement>) => Promise<void>;
  deleteElement: (guid: string) => Promise<void>;
  translateElement: (guid: string, dx: number, dy: number, dz?: number) => Promise<void>;
  updateGeoreferencing: (data: BimStoreState['georeference']) => Promise<void>;
  addViewportToSheet: (sheetId: string, viewId: string, x: number, y: number) => void;
  exportSheetPdf: (sheetId: string, svgContent: string) => Promise<void>;
  exportIfc: () => Promise<void>;

  // GLM Spec v2 Additions
  displayUnit: UnitSystem;
  setDisplayUnit: (unit: UnitSystem) => void;

  wallJoins: Record<string, WallJoinState>;
  fetchWallJoins: () => Promise<void>;
  setWallJoin: (wallGuid: string, endIdx: number, allowJoin: boolean, mode: 'butt' | 'miter' | 'square_off') => Promise<void>;

  // P4 sketch commands (all bus commands, so journaled and undoable). Both the
  // 2D sketch editor and direct manipulation call these; neither owns geometry.
  sketchAddCurve: (guid: string, curveId: string, start: [number, number],
                   end: [number, number], definesSlope?: boolean, slopeAngle?: number) => Promise<void>;
  sketchMoveVertex: (guid: string, curveId: string, endIndex: 0 | 1,
                     to: [number, number]) => Promise<void>;
  sketchMoveEdge: (guid: string, curveId: string, dx: number, dy: number) => Promise<void>;
  sketchSetSlope: (guid: string, curveId: string, definesSlope: boolean,
                   slopeAngle?: number) => Promise<void>;

  // P3 modify tools (all bus commands, so journaled and undoable)
  copyElement: (guid: string, dx: number, dy: number, dz?: number) => Promise<void>;
  rotateElement: (guid: string, angleDegrees: number, center?: [number, number]) => Promise<void>;
  offsetElement: (guid: string, distance: number, side?: 1 | -1) => Promise<void>;
  trimExtendWall: (guid: string, endIndex: 0 | 1, targetGuid: string) => Promise<void>;
  splitWall: (guid: string, atOffset: number) => Promise<void>;
  moveLevel: (levelId: string, elevation: number) => Promise<void>;

  executeTransaction: (commands: CommandPayload[], origin?: 'ui' | 'ai' | 'script' | 'cli', description?: string) => Promise<any>;
  /**
   * P1: the single mutation entry point for UI actions. Wraps one typed command
   * in an atomic, journaled transaction and refreshes view state from the
   * engine. Any mutation that does not go through here is a bug.
   */
  dispatchTransaction: (action: UiAction, params: Record<string, unknown>, description?: string) => Promise<any>;
  undoTransaction: () => Promise<void>;
  redoTransaction: () => Promise<void>;
  transactionJournal: TransactionJournalEntry[];
  fetchTransactionJournal: () => Promise<void>;

  isPromptBarOpen: boolean;
  setPromptBarOpen: (open: boolean) => void;
  aiPlanPreview: AiPlan | null;
  setAiPlanPreview: (plan: AiPlan | null) => void;
  generateAiPlan: (promptText: string) => Promise<AiPlan | null>;
  commitAiPlan: () => Promise<void>;
  discardAiPlan: () => void;

  exportProjectContainer: () => Promise<void>;
  loadProjectContainer: (file: File) => Promise<boolean>;

  // Sketch Mode Subsystem (Revit Edit Boundary / Edit Footprint / Create)
  sketchSession: SketchSession | null;
  startSketchMode: (mode: 'floor' | 'roof', targetGuid?: string) => void;
  cancelSketchMode: () => void;
  finishSketchMode: () => Promise<boolean>;
  addSketchLine: (start: [number, number], end: [number, number]) => void;
  addSketchRectangle: (p1: [number, number], p2: [number, number]) => void;
  addSketchFromWall: (wallGuid: string) => void;
  deleteSelectedSketchLine: () => void;
  selectSketchLine: (id: string | null) => void;
  updateSketchLine: (id: string, updates: Partial<SketchLine>) => void;
  setSketchDrawTool: (tool: SketchDrawTool) => void;
  setSketchParam: (key: 'elevation' | 'thickness' | 'pitch' | 'defaultDefinesSlope' | 'defaultSlopeAngle' | 'defaultOverhang', value: any) => void;
}

export const useBimStore = create<BimStoreState>((set, get) => ({
  activeRibbonTab: 'Architecture',
  activeTool: 'select',
  keyBuffer: '',
  keyBufferTimeout: null,

  projectName: 'BIMWorks Architectural Project',
  levels: [
    { id: 'lvl-1', name: 'Level 1', elevation: 0.0 },
    { id: 'lvl-2', name: 'Level 2', elevation: 10.0 },
    { id: 'lvl-3', name: 'Roof', elevation: 20.0 },
  ],
  views: [
    {
      id: 'view-3d',
      name: '{3D}',
      type: '3d',
      scale: '1/8" = 1\'-0"',
      detailLevel: 'medium',
      visualStyle: 'consistent_colors',
      viewRange: { top: 2.3, cut: 1.2, bottom: 0.0, viewDepth: 0.0 },
      sectionBox: { enabled: false, min: [-2, -2, -0.5], max: [14, 11, 4.0] },
    },
    {
      id: 'view-level-1',
      name: 'Floor Plan: Level 1',
      type: 'floor_plan',
      levelId: 'lvl-1',
      scale: '1/4" = 1\'-0"',
      detailLevel: 'medium',
      visualStyle: 'hidden_line',
      viewRange: { top: 2.3, cut: 1.2, bottom: 0.0, viewDepth: 0.0 },
    },
    {
      id: 'view-level-2',
      name: 'Floor Plan: Level 2',
      type: 'floor_plan',
      levelId: 'lvl-2',
      scale: '1/4" = 1\'-0"',
      detailLevel: 'medium',
      visualStyle: 'hidden_line',
      viewRange: { top: 2.3, cut: 1.2, bottom: 0.0, viewDepth: 0.0 },
    },
    {
      id: 'view-roof-plan',
      name: 'Roof Plan',
      type: 'floor_plan',
      levelId: 'lvl-roof',
      scale: '1/4" = 1\'-0"',
      detailLevel: 'medium',
      visualStyle: 'hidden_line',
      viewRange: { top: 15.0, cut: 8.0, bottom: 0.0, viewDepth: 0.0 },
    },
    {
      id: 'view-section-1',
      name: 'Building Section 1',
      type: 'section',
      scale: '1/4" = 1\'-0"',
      detailLevel: 'fine',
      visualStyle: 'hidden_line',
      viewRange: { top: 6.0, cut: 1.2, bottom: 0.0, viewDepth: 0.0 },
    },
  ],
  activeViewId: 'view-3d',

  sheets: [
    {
      id: 'sheet-a101',
      sheetNumber: 'A101',
      sheetTitle: 'FLOOR PLAN & SECTIONS',
      paperSize: 'ARCH_D',
      projectName: 'BIMWorks Prototype Building',
      date: '2026-10-13',
      drawnBy: 'BIMWorks Architect',
      viewports: [
        {
          id: 'vp-1',
          viewId: 'view-level-1',
          x: 80,
          y: 120,
          width: 480,
          height: 380,
          scaleFactor: 1.0,
        },
      ],
    },
    {
      id: 'sheet-a201',
      sheetNumber: 'A201',
      sheetTitle: 'BUILDING ELEVATIONS',
      paperSize: 'ARCH_D',
      projectName: 'BIMWorks Prototype Building',
      date: '2026-10-13',
      drawnBy: 'BIMWorks Architect',
      viewports: [],
    },
  ],
  activeSheetId: 'sheet-a101',

  elements: {},
  meshes: [],
  grids: [],
  sliced2D: null,

  // 1D/2D Parametric Constraints
  constraints: [],
  alignPickState: { step: null, refGuid: null },

  selectedGuid: null,
  hoveredGuid: null,

  sectionBox: {
    enabled: false,
    min: [-2, -2, -0.5],
    max: [14, 11, 4.0],
  },
  hiddenGuids: [],
  isolatedGuids: [],
  tempDimension: null,

  georeference: {
    projected_crs: 'EPSG:2285 - NAD83 / Washington North',
    eastings: 1275432.10,
    northings: 234567.89,
    elevation: 45.0,
    true_north: 12.5,
    scale: 1.0,
  },

  isGeoreferenceModalOpen: false,
  isEditTypeModalOpen: false,
  isViewRangeModalOpen: false,
  isLegalModalOpen: false,

  isLoadingFile: false,
  statusMessage: 'Ready (IFC4 Native BIM)',
  setStatusMessage: (msg: string) => set({ statusMessage: msg }),

  activeScale: '1/4" = 1\'-0"',
  activeDetailLevel: 'medium',
  activeVisualStyle: 'consistent_colors',

  // GLM Spec v2 Initial States
  displayUnit: 'imperial_fractional',
  setDisplayUnit: (unit: UnitSystem) => set({ displayUnit: unit }),
  wallJoins: {},
  transactionJournal: [],
  isPromptBarOpen: false,
  setPromptBarOpen: (open: boolean) => set({ isPromptBarOpen: open }),
  aiPlanPreview: null,
  setAiPlanPreview: (plan: AiPlan | null) => set({ aiPlanPreview: plan }),

  // Sketch Mode Subsystem State
  sketchSession: null,

  // Actions
  setActiveRibbonTab: (tab) => set({ activeRibbonTab: tab }),
  setActiveTool: (tool) => {
    if (tool === 'AL') {
      set({ activeTool: 'AL', alignPickState: { step: 'pick_ref', refGuid: null } });
    } else {
      set({ activeTool: tool, alignPickState: { step: null, refGuid: null } });
    }
  },

  // Revit Two-Letter Non-Modifier Hotkey Engine (1000ms debounce)
  handleKeyStroke: (key) => {
    const state = get();
    const upperKey = key.toUpperCase();

    // Escape cancels tool and clears selection / cancels sketch session
    if (key === 'Escape') {
      get().clearKeyBuffer();
      if (state.sketchSession) {
        if (state.sketchSession.selectedLineId) {
          get().selectSketchLine(null);
          return;
        }
        get().cancelSketchMode();
        return;
      }
      set({
        activeTool: 'select',
        selectedGuid: null,
        tempDimension: null,
        alignPickState: { step: null, refGuid: null },
      });
      return;
    }

    // Enter commits active sketch mode
    if (key === 'Enter' && state.sketchSession) {
      get().finishSketchMode();
      return;
    }

    // Hotkey lookup table
    const hotkeys: Record<string, () => void> = {
      WA: () => set({ activeTool: 'WA', activeRibbonTab: 'Architecture' }),
      DR: () => set({ activeTool: 'DR', activeRibbonTab: 'Architecture' }),
      WN: () => set({ activeTool: 'WN', activeRibbonTab: 'Architecture' }),
      SB: () => get().startSketchMode('floor'),
      RF: () => get().startSketchMode('roof'),
      LI: () => {
        if (get().sketchSession) get().setSketchDrawTool('line');
      },
      RE: () => {
        if (get().sketchSession) get().setSketchDrawTool('rectangle');
      },
      PW: () => {
        if (get().sketchSession) get().setSketchDrawTool('pick_walls');
      },
      GR: () => set({ activeTool: 'GR', activeRibbonTab: 'Architecture' }),
      LL: () => set({ activeTool: 'LL', activeRibbonTab: 'Architecture' }),
      DI: () => set({ activeTool: 'DI', activeRibbonTab: 'Annotate' }),
      DL: () => set({ activeTool: 'DL', activeRibbonTab: 'Annotate' }),
      TG: () => set({ activeTool: 'TG', activeRibbonTab: 'Annotate' }),
      TX: () => set({ activeTool: 'TX', activeRibbonTab: 'Annotate' }),
      SEC: () => set({ activeTool: 'SEC', activeRibbonTab: 'View' }),
      SHT: () => set({ activeTool: 'SHT', activeRibbonTab: 'View' }),
      BX: () => get().toggleSectionBox(),
      AL: () =>
        set({
          activeTool: 'AL',
          activeRibbonTab: 'Architecture',
          alignPickState: { step: 'pick_ref', refGuid: null },
        }),
      EQ: () => get().equalizeSouthWallWindows(),
      HH: () => get().tempHideSelected(),
      HR: () => get().resetTempVisibility(),
      HI: () => get().tempIsolateSelected(),
      ZE: () => {
        // Trigger zoom extents event
        window.dispatchEvent(new CustomEvent('orlt-zoom-extents'));
      },
    };

    if (state.keyBufferTimeout) {
      clearTimeout(state.keyBufferTimeout);
    }

    const newBuffer = (state.keyBuffer + upperKey).slice(-3); // Keep up to 3 chars for SEC / SHT

    // Check if newBuffer matches any hotkey
    if (hotkeys[newBuffer]) {
      hotkeys[newBuffer]();
      set({ keyBuffer: '', keyBufferTimeout: null });
      return;
    }

    // Set buffer with 1000ms auto-clear
    const timeout = setTimeout(() => {
      set({ keyBuffer: '', keyBufferTimeout: null });
    }, 1000);

    set({ keyBuffer: newBuffer, keyBufferTimeout: timeout });
  },

  clearKeyBuffer: () => {
    const { keyBufferTimeout } = get();
    if (keyBufferTimeout) clearTimeout(keyBufferTimeout);
    set({ keyBuffer: '', keyBufferTimeout: null });
  },

  setActiveViewId: (id) => {
    set({ activeViewId: id });
    const view = get().views.find((v) => v.id === id);
    // Any 2D view type, not just plans: sections and elevations are drawn by the same
    // view engine and were previously never requested.
    if (view && view.type !== '3d' && view.type !== 'sheet') {
      get().fetch2DSlice(view.viewRange.cut);
    }
  },

  setActiveSheetId: (id) => set({ activeSheetId: id }),

  setSelectedGuid: (guid) => {
    set({ selectedGuid: guid });
    if (!guid) {
      set({ tempDimension: null });
      return;
    }

    // Temporary dimension from tessellation bounds.
    //
    // NOTE (honest limitation): the engine exposes no witness-line model yet, so
    // this measures centre-to-centre distance to the nearest OTHER element's
    // bbox centre. It is a real measured distance between real elements — not a
    // fabricated default. When the element is the only one in the model there is
    // nothing to measure against, so no dimension is created rather than
    // inventing a 12'-0" reading.
    const mesh = get().meshes.find((m) => m.guid === guid);
    if (mesh) {
      const center: [number, number, number] = [
        (mesh.bbox.min[0] + mesh.bbox.max[0]) / 2,
        (mesh.bbox.min[1] + mesh.bbox.max[1]) / 2,
        (mesh.bbox.min[2] + mesh.bbox.max[2]) / 2,
      ];

      const otherMeshes = get().meshes.filter((m) => m.guid !== guid);
      let nearestDist = Number.POSITIVE_INFINITY;
      let nearestCenter: [number, number, number] | null = null;

      for (const other of otherMeshes) {
        const oCenter: [number, number, number] = [
          (other.bbox.min[0] + other.bbox.max[0]) / 2,
          (other.bbox.min[1] + other.bbox.max[1]) / 2,
          (other.bbox.min[2] + other.bbox.max[2]) / 2,
        ];
        const dist = Math.hypot(center[0] - oCenter[0], center[1] - oCenter[1]);
        if (dist > 0.5 && dist < nearestDist) {
          nearestDist = dist;
          nearestCenter = oCenter;
        }
      }

      if (!nearestCenter || !Number.isFinite(nearestDist)) {
        set({ tempDimension: null });
        return;
      }

      const feet = Math.floor(nearestDist * 3.28084);
      const inches = Math.round((nearestDist * 3.28084 - feet) * 12);
      const display = `${feet}'-${inches}"`;

      // Measure along the dominant axis of the witness pair, not a fixed 'x',
      // so the pill and its edit gesture match the direction being measured.
      const axis: 'x' | 'y' =
        Math.abs(nearestCenter[0] - center[0]) >= Math.abs(nearestCenter[1] - center[1])
          ? 'x'
          : 'y';

      set({
        tempDimension: {
          elementGuid: guid,
          distance: nearestDist,
          displayValue: display,
          witnessP1: nearestCenter,
          witnessP2: center,
          center: [
            (nearestCenter[0] + center[0]) / 2,
            (nearestCenter[1] + center[1]) / 2,
            (nearestCenter[2] + center[2]) / 2,
          ],
          axis,
        },
      });
    }
  },

  setHoveredGuid: (guid) => set({ hoveredGuid: guid }),

  toggleSectionBox: () =>
    set((state) => ({
      sectionBox: {
        ...state.sectionBox,
        enabled: !state.sectionBox.enabled,
      },
    })),

  setSectionBoxBounds: (min, max) =>
    set((state) => ({
      sectionBox: {
        ...state.sectionBox,
        min,
        max,
      },
    })),

  tempHideSelected: () => {
    const { selectedGuid, hiddenGuids } = get();
    if (selectedGuid && !hiddenGuids.includes(selectedGuid)) {
      set({ hiddenGuids: [...hiddenGuids, selectedGuid], selectedGuid: null });
    }
  },

  tempIsolateSelected: () => {
    const { selectedGuid } = get();
    if (selectedGuid) {
      set({ isolatedGuids: [selectedGuid] });
    }
  },

  resetTempVisibility: () => set({ hiddenGuids: [], isolatedGuids: [] }),

  setTempDimension: (dim) => set({ tempDimension: dim }),

  applyTemporaryDimensionChange: async (newValue: number) => {
    const { tempDimension, translateElement } = get();
    if (!tempDimension) return;

    // Move along the axis the dimension actually measures (set when the
    // dimension was created) instead of always translating world X.
    const delta = newValue - tempDimension.distance;
    const dx = tempDimension.axis === 'x' ? delta : 0;
    const dy = tempDimension.axis === 'y' ? delta : 0;
    await translateElement(tempDimension.elementGuid, dx, dy, 0);
    get().setSelectedGuid(tempDimension.elementGuid);
  },

  setScale: (scale) => set({ activeScale: scale }),
  setDetailLevel: (detail) => set({ activeDetailLevel: detail }),
  setVisualStyle: (style) => set({ activeVisualStyle: style }),

  setGeoreferenceModalOpen: (open) => set({ isGeoreferenceModalOpen: open }),
  setEditTypeModalOpen: (open) => set({ isEditTypeModalOpen: open }),
  setViewRangeModalOpen: (open) => set({ isViewRangeModalOpen: open }),
  setLegalModalOpen: (open) => set({ isLegalModalOpen: open }),

  // 1D/2D Parametric Constraints Implementation
  setAlignPickState: (state) => set({ alignPickState: state }),

  fetchConstraints: async () => {
    try {
      const res = await fetch(`${API_BASE}/constraints`);
      if (res.ok) {
        const data = await res.json();
        set({ constraints: data || [] });
      }
    } catch (e) {
      console.error('Failed to fetch constraints', e);
    }
  },

  createAlignConstraint: async (refGuid: string, targetGuid: string, axis = 'x', lock = true) => {
    try {
      await get().dispatchTransaction(
        'createAlignConstraint',
        { ref_guid: refGuid, target_guid: targetGuid, axis, lock },
        'Align & lock elements'
      );
      set({ alignPickState: { step: null, refGuid: null }, activeTool: 'select' });
    } catch (e) {
      console.error('Failed to create align constraint', e);
    }
  },

  toggleConstraintLock: async (constraintId: string, isLocked: boolean) => {
    try {
      await get().dispatchTransaction(
        'toggleConstraintLock',
        { constraint_id: constraintId, is_locked: isLocked },
        isLocked ? 'Lock constraint' : 'Unlock constraint'
      );
    } catch (e) {
      console.error('Failed to toggle constraint lock', e);
    }
  },

  lockDimension: async (guidA: string, guidB: string, distance?: number, axis = 'x') => {
    try {
      await get().dispatchTransaction(
        'lockDimension',
        {
          guid_a: guidA,
          guid_b: guidB,
          locked_distance: distance,
          lock: true,
          axis,
        },
        'Lock dimension'
      );
    } catch (e) {
      console.error('Failed to lock dimension', e);
    }
  },

  equalizeSpan: async (
    spanStartGuid: string,
    spanEndGuid: string,
    interiorGuids: string[],
    axis = 'x'
  ) => {
    try {
      await get().dispatchTransaction(
        'equalizeSpan',
        {
          span_start_guid: spanStartGuid,
          span_end_guid: spanEndGuid,
          interior_guids: interiorGuids,
          axis,
        },
        'Equalize spacing (EQ)'
      );
    } catch (e) {
      console.error('Failed to equalize span', e);
    }
  },

  deleteConstraint: async (constraintId: string) => {
    try {
      await get().dispatchTransaction(
        'deleteConstraint',
        { constraint_id: constraintId },
        'Delete constraint'
      );
    } catch (e) {
      console.error('Failed to delete constraint', e);
    }
  },

  equalizeSouthWallWindows: async () => {
    const { meshes, elements } = get();
    const windows = meshes.filter((m) => m.ifc_class === 'IfcWindow');
    if (windows.length < 2) return;

    // "South wall" is the host of the windows to equalize. There is no compass
    // in the model yet, so instead of blindly taking store order (`walls[0]`),
    // pick the wall that actually hosts the most windows, breaking ties by the
    // longest baseline. That is a deterministic, geometry-derived choice.
    const hostCounts = new Map<string, number>();
    for (const w of windows) {
      const host = elements[w.guid]?.host_wall_guid;
      if (host) hostCounts.set(host, (hostCounts.get(host) ?? 0) + 1);
    }
    const southWall =
      [...hostCounts.entries()].sort((a, b) => {
        if (b[1] !== a[1]) return b[1] - a[1];
        return (elements[b[0]]?.length ?? 0) - (elements[a[0]]?.length ?? 0);
      })[0]?.[0] ?? meshes.find((m) => WALL_CLASSES.includes(m.ifc_class))?.guid;

    if (!southWall) return;

    // Equalize the windows hosted on that wall (not every window in the model).
    const hostedWindows = windows
      .filter((w) => elements[w.guid]?.host_wall_guid === southWall)
      .map((w) => w.guid);
    const targets = hostedWindows.length >= 2 ? hostedWindows : windows.map((w) => w.guid);

    await get().equalizeSpan(southWall, southWall, targets, 'x');
  },

  // API Callbacks
  fetchProjectState: async () => {
    try {
      await get().fetchConstraints();
      const res = await fetch(`${API_BASE}/project`);
      if (res.ok) {
        const data = await res.json();
        set({
          projectName: data.project_name || get().projectName,
          georeference: data.georeference || get().georeference,
        });
      }
    } catch (e) {
      console.warn('Backend not yet reachable', e);
    }
  },

  fetchGeometry: async () => {
    try {
      const res = await fetch(`${API_BASE}/geometry`);
      if (res.ok) {
        const data = await res.json();
        const meshes: MeshBufferData[] = data.meshes || [];
        // The `elements` record mirrors the engine's `element_meta`, not the
        // tessellation: baselines, host GUIDs, and door/window offsets only
        // exist in the parametric payload. Previously this record was declared
        // but never populated, so AI-planned door/window inserts saw zero walls.
        const elements: Record<string, BimElement> = {};
        for (const mesh of meshes) {
          const params = mesh.params;
          if (!params) continue;
          elements[mesh.guid] = {
            guid: mesh.guid,
            ifc_class: (params.ifc_class || mesh.ifc_class) as BimElement['ifc_class'],
            name: params.name || mesh.name,
            start: params.start,
            end: params.end,
            length: params.length,
            height: params.height,
            thickness: params.thickness,
            angle: params.angle,
            level_id: params.level_id,
            host_wall_guid: params.host_wall_guid,
            offset_along_wall: params.offset_along_wall,
            width: params.width,
            sill_height: params.sill_height,
            swing_flipped: params.swing_flipped,
            elevation: params.elevation,
            pitch: params.pitch,
            tag: params.tag,
            type_properties: params.type_properties,
          };
        }
        set({
          meshes,
          elements,
          levels: data.levels || get().levels,
          grids: data.grids || get().grids,
        });
      }
    } catch (e) {
      console.error('Failed to fetch geometry', e);
    }
  },

  fetch2DSlice: async (cutElevation) => {
    try {
      // Route by the active view's own type. Before this, only floor plans fetched
      // anything, so selecting a section or elevation left the viewport empty even
      // though the backend could draw both.
      const active = get().views.find((v) => v.id === get().activeViewId);
      const viewType = active?.type ?? 'floor_plan';
      const range = active?.viewRange;
      const cut = cutElevation ?? range?.cut ?? 4.0;

      let url: string;
      if (viewType === 'section' || viewType === 'elevation') {
        const params = new URLSearchParams({
          view_type: viewType,
          cut_elevation: String(cut),
          // The store uses camelCase; the API uses the Revit field names.
          ...(range?.top !== undefined ? { top: String(range.top) } : {}),
          ...(range?.bottom !== undefined ? { bottom: String(range.bottom) } : {}),
          // A view depth of 0 means "not set"; sending it would filter everything out.
          ...(range?.viewDepth ? { view_depth: String(range.viewDepth) } : {}),
        });
        url = `${API_BASE}/view/2d?${params.toString()}`;
      } else {
        url = `${API_BASE}/slice/2d?cut_elevation=${cut}`;
      }

      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        set({ sliced2D: data });
      }
    } catch (e) {
      console.error('Failed to fetch 2D view', e);
    }
  },

  loadSampleProject: async () => {
    try {
      set({ isLoadingFile: true, statusMessage: 'Loading Sample BIM Building...' });
      const res = await fetch(`${API_BASE}/sample`, { method: 'POST' });
      if (res.ok) {
        await get().fetchGeometry();
        await get().fetch2DSlice();
        await get().fetchProjectState();
        set({
          projectName: 'BIMWorks Prototype Building',
          isLoadingFile: false,
          statusMessage: 'Sample BIM Project Loaded (13 Elements, 3 Levels)',
        });
      }
    } catch (e) {
      console.error('Failed to load sample building', e);
      set({ isLoadingFile: false, statusMessage: 'Failed to load sample building' });
    }
  },

  loadIfcContent: async (content: string, filename = 'Imported.ifc') => {
    try {
      set({ isLoadingFile: true, statusMessage: `Loading ${filename}...` });
      const res = await fetch(`${API_BASE}/load-file`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, filename }),
      });
      if (res.ok) {
        const data = await res.json();
        set({
          projectName: data.project_name || filename,
          isLoadingFile: false,
          statusMessage: `Successfully loaded ${filename} (${data.elements_count} elements, ${data.levels_count} levels)`,
          selectedGuid: null,
          hoveredGuid: null,
        });
        await get().fetchGeometry();
        await get().fetch2DSlice();
        await get().fetchProjectState();
        await get().fetchConstraints();
        return true;
      } else {
        const err = await res.json().catch(() => ({ detail: 'Unknown error' }));
        set({
          isLoadingFile: false,
          statusMessage: `Error loading ${filename}: ${err.detail || res.statusText}`,
        });
        return false;
      }
    } catch (e: any) {
      console.error('Failed to load IFC content', e);
      set({
        isLoadingFile: false,
        statusMessage: `Error loading file: ${e.message || 'Network error'}`,
      });
      return false;
    }
  },

  loadIfcFile: async (file: File) => {
    return new Promise<boolean>((resolve) => {
      set({ isLoadingFile: true, statusMessage: `Reading ${file.name}...` });
      const reader = new FileReader();
      reader.onload = async (e) => {
        const text = e.target?.result as string;
        if (text) {
          const success = await get().loadIfcContent(text, file.name);
          resolve(success);
        } else {
          set({ isLoadingFile: false, statusMessage: `Empty file: ${file.name}` });
          resolve(false);
        }
      };
      reader.onerror = () => {
        set({ isLoadingFile: false, statusMessage: `Failed to read file ${file.name}` });
        resolve(false);
      };
      reader.readAsText(file);
    });
  },

  createWall: async (start, end, name = 'Basic Wall : Exterior - 10" CMU') => {
    try {
      await get().dispatchTransaction(
        'createWall',
        { start, end, height: 10.0, thickness: 0.8333, name },
        `Create wall "${name}"`
      );
      set({ activeTool: 'select' });
    } catch (e) {
      console.error('Failed to create wall', e);
    }
  },

  createDoor: async (hostWallGuid, offset, name = 'Single Flush : 36" x 84"') => {
    try {
      await get().dispatchTransaction(
        'createDoor',
        { host_wall_guid: hostWallGuid, offset_along_wall: offset, name },
        'Insert door'
      );
      set({ activeTool: 'select' });
    } catch (e) {
      console.error('Failed to insert door', e);
    }
  },

  createWindow: async (hostWallGuid, offset, name = 'Fixed Window : 48" x 48"') => {
    try {
      await get().dispatchTransaction(
        'createWindow',
        {
          host_wall_guid: hostWallGuid,
          offset_along_wall: offset,
          width: 4.0,
          height: 4.0,
          sill_height: 3.0,
          name,
        },
        'Insert window'
      );
      set({ activeTool: 'select' });
    } catch (e) {
      console.error('Failed to insert window', e);
    }
  },

  createRoof: async (polygon, thickness = 0.3, elevation = 6.0, pitch_degrees = 15.0, name = 'Roof : Pitched Metal Deck') => {
    try {
      await get().dispatchTransaction(
        'createRoof',
        { polygon, thickness, elevation, pitch_degrees, name },
        'Create roof'
      );
      set({ activeTool: 'select' });
    } catch (e) {
      console.error('Failed to create roof', e);
    }
  },

  createSlab: async (polygon, thickness = 0.25, elevation = 0.0, name = 'Floor : 10" Concrete Slab') => {
    try {
      await get().dispatchTransaction(
        'createSlab',
        { polygon, thickness, elevation, name },
        'Create slab'
      );
      set({ activeTool: 'select' });
    } catch (e) {
      console.error('Failed to create slab', e);
    }
  },

  updateElement: async (guid: string, updates: Partial<BimElement>) => {
    try {
      await get().dispatchTransaction(
        'updateElement',
        { guid, updates },
        'Edit element geometry'
      );
    } catch (e) {
      console.error('Failed to update element', e);
    }
  },

  deleteElement: async (guid) => {
    try {
      await get().dispatchTransaction('deleteElement', { guid }, 'Delete element');
      set({ selectedGuid: null, tempDimension: null });
    } catch (e) {
      console.error('Failed to delete element', e);
    }
  },

  translateElement: async (guid, dx, dy, dz = 0.0) => {
    try {
      await get().dispatchTransaction('translateElement', { guid, dx, dy, dz }, 'Move element');
    } catch (e) {
      console.error('Failed to translate element', e);
    }
  },

  updateGeoreferencing: async (data) => {
    try {
      const res = await fetch(`${API_BASE}/georeference`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (res.ok) {
        set({ georeference: data });
      }
    } catch (e) {
      console.error('Failed to update georeferencing', e);
    }
  },

  addViewportToSheet: (sheetId, viewId, x, y) => {
    set((state) => {
      const sheet = state.sheets.find((s) => s.id === sheetId);
      if (!sheet) return state;

      const newViewport: SheetViewport = {
        id: `vp-${Date.now()}`,
        viewId,
        x,
        y,
        width: 480,
        height: 360,
        scaleFactor: 1.0,
      };

      return {
        sheets: state.sheets.map((s) =>
          s.id === sheetId ? { ...s, viewports: [...s.viewports, newViewport] } : s
        ),
      };
    });
  },

  exportSheetPdf: async (sheetId, svgContent) => {
    try {
      const sheet = get().sheets.find((s) => s.id === sheetId);
      const name = sheet ? `${sheet.sheetNumber}_${sheet.sheetTitle}` : 'Sheet_Export';

      const res = await fetch(`${API_BASE}/export/sheet-pdf`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ svg_content: svgContent, sheet_name: name }),
      });

      if (res.ok) {
        const blob = await res.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${name}.pdf`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        window.URL.revokeObjectURL(url);
      }
    } catch (e) {
      console.error('Failed to export vector sheet PDF', e);
    }
  },

  exportIfc: async () => {
    try {
      const res = await fetch(`${API_BASE}/export/ifc`);
      if (res.ok) {
        const text = await res.text();
        const blob = new Blob([text], { type: 'application/x-step' });
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'BIMWorks_Model.ifc';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        window.URL.revokeObjectURL(url);
      }
    } catch (e) {
      console.error('Failed to export IFC', e);
    }
  },

  // =========================================================================
  // GLM MASTER SPEC v2.1 IMPLEMENTATIONS
  // =========================================================================

  exportProjectContainer: async () => {
    try {
      set({ statusMessage: 'Exporting .bimworks Project Container...' });
      const res = await fetch(`${API_BASE}/project/export-bimworks`);
      if (res.ok) {
        const blob = await res.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const pName = get().projectName.replace(/[^a-zA-Z0-9_-]/g, '_') || 'BIMWorks_Project';
        a.download = `${pName}.bimworks`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        window.URL.revokeObjectURL(url);
        set({ statusMessage: `Exported ${pName}.bimworks (Project Container)` });
      }
    } catch (e) {
      console.error('Failed to export .bimworks project', e);
      set({ statusMessage: 'Error exporting .bimworks project' });
    }
  },

  loadProjectContainer: async (file: File) => {
    set({ isLoadingFile: true, statusMessage: `Unpacking project container: ${file.name}...` });
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch(`${API_BASE}/project/load-bimworks`, {
        method: 'POST',
        body: formData,
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: 'Network error' }));
        set({
          isLoadingFile: false,
          statusMessage: `Error loading container: ${err.detail || 'Failed to unpack'}`,
        });
        return false;
      }

      await get().fetchProjectState();
      await get().fetchGeometry();
      await get().fetch2DSlice();
      await get().fetchConstraints();
      await get().fetchWallJoins();

      set({
        isLoadingFile: false,
        statusMessage: `Successfully loaded ${file.name} (BIMWorks Project Container)`,
      });
      return true;
    } catch (e) {
      console.error('Error in loadProjectContainer:', e);
      set({
        isLoadingFile: false,
        statusMessage: `Error: ${e instanceof Error ? e.message : 'Unknown failure'}`,
      });
      return false;
    }
  },

  fetchWallJoins: async () => {
    try {
      const res = await fetch(`${API_BASE}/wall/joins`);
      if (res.ok) {
        const joins = await res.json();
        set({ wallJoins: joins });
      }
    } catch (e) {
      console.error('Failed to fetch wall joins', e);
    }
  },

  sketchAddCurve: async (guid, curveId, start, end, definesSlope = false, slopeAngle) => {
    try {
      await get().dispatchTransaction(
        'sketchAddCurve',
        {
          guid,
          curve_id: curveId,
          start,
          end,
          defines_slope: definesSlope,
          slope_angle: slopeAngle ?? null,
        },
        'Sketch: add curve'
      );
    } catch (e) {
      console.error('Failed to add sketch curve', e);
    }
  },

  sketchMoveVertex: async (guid, curveId, endIndex, to) => {
    try {
      await get().dispatchTransaction(
        'sketchMoveVertex',
        { guid, curve_id: curveId, end_index: endIndex, to },
        'Sketch: drag vertex'
      );
    } catch (e) {
      console.error('Failed to move sketch vertex', e);
    }
  },

  sketchMoveEdge: async (guid, curveId, dx, dy) => {
    try {
      await get().dispatchTransaction(
        'sketchMoveEdge',
        { guid, curve_id: curveId, dx, dy },
        'Sketch: drag edge'
      );
    } catch (e) {
      console.error('Failed to move sketch edge', e);
    }
  },

  sketchSetSlope: async (guid, curveId, definesSlope, slopeAngle) => {
    try {
      await get().dispatchTransaction(
        'sketchSetSlope',
        {
          guid,
          curve_id: curveId,
          defines_slope: definesSlope,
          slope_angle: slopeAngle ?? null,
        },
        'Sketch: define slope'
      );
    } catch (e) {
      console.error('Failed to set sketch slope', e);
    }
  },

  copyElement: async (guid, dx, dy, dz = 0.0) => {
    try {
      await get().dispatchTransaction('copyElement', { guid, dx, dy, dz }, 'Copy element');
    } catch (e) {
      console.error('Failed to copy element', e);
    }
  },

  rotateElement: async (guid, angleDegrees, center) => {
    try {
      await get().dispatchTransaction(
        'rotateElement',
        { guid, angle_degrees: angleDegrees, center: center ?? null },
        'Rotate element'
      );
    } catch (e) {
      console.error('Failed to rotate element', e);
    }
  },

  offsetElement: async (guid, distance, side = 1) => {
    try {
      await get().dispatchTransaction(
        'offsetElement',
        { guid, distance, side },
        'Offset element'
      );
    } catch (e) {
      console.error('Failed to offset element', e);
    }
  },

  trimExtendWall: async (guid, endIndex, targetGuid) => {
    try {
      await get().dispatchTransaction(
        'trimExtendWall',
        { guid, end_index: endIndex, target_guid: targetGuid },
        'Trim/Extend wall'
      );
    } catch (e) {
      console.error('Failed to trim/extend wall', e);
    }
  },

  splitWall: async (guid, atOffset) => {
    try {
      await get().dispatchTransaction('splitWall', { guid, at_offset: atOffset }, 'Split wall');
    } catch (e) {
      console.error('Failed to split wall', e);
    }
  },

  moveLevel: async (levelId, elevation) => {
    try {
      await get().dispatchTransaction(
        'moveLevel',
        { level_id: levelId, elevation },
        'Move level'
      );
    } catch (e) {
      console.error('Failed to move level', e);
    }
  },

  setWallJoin: async (wallGuid, endIdx, allowJoin, mode) => {
    try {
      await get().dispatchTransaction(
        'setWallJoin',
        {
          wall_guid: wallGuid,
          end_index: endIdx,
          allow_join: allowJoin,
          mode: mode,
        },
        'Change wall join'
      );
    } catch (e) {
      console.error('Failed to set wall join', e);
    }
  },

  executeTransaction: async (commands, origin = 'ui', description = 'Transaction') => {
    try {
      const res = await fetch(`${API_BASE}/transaction`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          commands,
          origin,
          description,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: 'Transaction error' }));
        throw new Error(err.detail || 'Transaction failed');
      }

      const data = await res.json();
      // View state is refreshed from the engine after every commit; the store
      // holds no independent model state.
      await get().fetchProjectState();
      await get().fetchGeometry();
      await get().fetch2DSlice();
      await get().fetchConstraints();
      await get().fetchWallJoins();
      await get().fetchTransactionJournal();

      return data;
    } catch (e) {
      console.error('executeTransaction error:', e);
      throw e;
    }
  },

  dispatchTransaction: async (action, params, description = 'Edit') => {
    const command = UI_ACTION_COMMANDS[action];
    return get().executeTransaction(
      [{ command, params, origin: 'ui' }],
      'ui',
      description || command
    );
  },

  undoTransaction: async () => {
    try {
      const res = await fetch(`${API_BASE}/transaction/undo`, { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        set({ statusMessage: `Undone transaction (${data.description || 'Done'})` });
        await get().fetchGeometry();
        await get().fetch2DSlice();
        await get().fetchProjectState();
        await get().fetchTransactionJournal();
      }
    } catch (e) {
      console.error('undoTransaction error:', e);
    }
  },

  redoTransaction: async () => {
    try {
      const res = await fetch(`${API_BASE}/transaction/redo`, { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        set({ statusMessage: `Redone transaction (${data.description || 'Done'})` });
        await get().fetchGeometry();
        await get().fetch2DSlice();
        await get().fetchProjectState();
        await get().fetchTransactionJournal();
      }
    } catch (e) {
      console.error('redoTransaction error:', e);
    }
  },

  fetchTransactionJournal: async () => {
    try {
      const res = await fetch(`${API_BASE}/transaction/journal?limit=25`);
      if (res.ok) {
        const journal = await res.json();
        set({ transactionJournal: journal });
      }
    } catch (e) {
      console.error('Failed to fetch transaction journal', e);
    }
  },

  generateAiPlan: async (promptText: string): Promise<AiPlan | null> => {
    const text = promptText.trim().toLowerCase();
    const elements = get().elements;
    const selectedGuid = get().selectedGuid;

    // Pattern 1: Create room / rectangular perimeter walls: "add 40x30 walls" or "40' by 30' perimeter"
    const rectMatch = text.match(/(\d+)(?:'|ft)?\s*(?:x|by|\*)\s*(\d+)(?:'|ft)?/i);
    if (rectMatch || text.includes('room') || text.includes('perimeter') || text.includes('walls')) {
      const wFeet = rectMatch ? parseFloat(rectMatch[1]) : 30;
      const dFeet = rectMatch ? parseFloat(rectMatch[2]) : 20;
      // Convert decimal feet to meters for engine geometry
      // Prompt dimensions are feet and the engine is feet: no conversion.
      const wM = wFeet;
      const dM = dFeet;

      return {
        intentSummary: `Create ${wFeet}' × ${dFeet}' perimeter wall enclosure (4 walls with Butt joins)`,
        commands: [
          {
            command: 'WallCreate',
            params: {
              start: [0, 0, 0],
              end: [wM, 0, 0],
              height: 10.0,
              thickness: 0.8333,
              name: 'Basic Wall : Exterior - 10" CMU',
            },
          },
          {
            command: 'WallCreate',
            params: {
              start: [wM, 0, 0],
              end: [wM, dM, 0],
              height: 10.0,
              thickness: 0.8333,
              name: 'Basic Wall : Exterior - 10" CMU',
            },
          },
          {
            command: 'WallCreate',
            params: {
              start: [wM, dM, 0],
              end: [0, dM, 0],
              height: 10.0,
              thickness: 0.8333,
              name: 'Basic Wall : Exterior - 10" CMU',
            },
          },
          {
            command: 'WallCreate',
            params: {
              start: [0, dM, 0],
              end: [0, 0, 0],
              height: 10.0,
              thickness: 0.8333,
              name: 'Basic Wall : Exterior - 10" CMU',
            },
          },
        ],
      };
    }

    // Pattern 2: Door insertion: "insert door" or "add door at 10 feet"
    if (text.includes('door')) {
      // Host wall comes from the real element record (engine `element_meta`),
      // so the baseline length below is a measured value, not a guess.
      const targetWall = pickHostWall(elements, selectedGuid);
      if (!targetWall) {
        throw new Error('No wall available to host the door. Create walls first.');
      }

      const doorWidth = 0.95;
      const offsetVal = planHostedOffset(text, elements[targetWall], doorWidth, 'centered');

      return {
        intentSummary: `Insert 36" × 84" Single Flush Door into host wall at ${offsetVal.toFixed(2)}m from its start`,
        affectedGuids: [targetWall],
        commands: [
          {
            command: 'DoorInsert',
            params: {
              host_wall_guid: targetWall,
              offset_along_wall: offsetVal,
              width: doorWidth,
              height: 7.0,
              name: 'Single Flush : 36" x 84"',
              swing_flipped: text.includes('flip'),
            },
          },
        ],
      };
    }

    // Pattern 3: Window insertion: "insert window" or "add 48x48 window"
    if (text.includes('window')) {
      const targetWall = pickHostWall(elements, selectedGuid);
      if (!targetWall) {
        throw new Error('No wall available to host window.');
      }

      const winWidth = 1.2;
      const winOffset = planHostedOffset(text, elements[targetWall], winWidth, 'start');

      return {
        intentSummary: `Insert 48" × 48" Fixed Window into host wall at ${winOffset.toFixed(2)}m from its start`,
        affectedGuids: [targetWall],
        commands: [
          {
            command: 'WindowInsert',
            params: {
              host_wall_guid: targetWall,
              offset_along_wall: winOffset,
              width: winWidth,
              height: 1.2,
              sill_height: 3.0,
              name: 'Fixed Window : 48" x 48"',
            },
          },
        ],
      };
    }

    // Pattern 4: Floor / Slab: "add floor", "create slab"
    if (text.includes('slab') || text.includes('floor')) {
      return {
        intentSummary: 'Construct 10" Concrete Slab foundation',
        commands: [
          {
            command: 'SlabCreate',
            params: {
              polygon: [
                [0, 0],
                [12, 0],
                [12, 9],
                [0, 9],
              ],
              thickness: 0.8333,
              elevation: 0.0,
              name: 'Floor : 10" Concrete Slab',
            },
          },
        ],
      };
    }

    // Pattern 5: Equalize windows or doors
    if (text.includes('equalize') || text.includes('eq')) {
      return {
        intentSummary: 'Equalize spacing across facade (EQ Constraint)',
        commands: [
          {
            command: 'ConstraintEqualize',
            params: {
              span_start_guid: Object.keys(elements)[0] || 'start',
              span_end_guid: Object.keys(elements)[1] || 'end',
              interior_guids: Object.keys(elements).slice(2, 4),
              axis: 'x',
            },
          },
        ],
      };
    }

    // Fallback: Generic architectural wall partition
    return {
      intentSummary: `Execute architectural operation: "${promptText}"`,
      commands: [
        {
          command: 'WallCreate',
          params: {
            start: [0, 0, 0],
            end: [6, 0, 0],
            height: 10.0,
            thickness: 0.15,
            name: 'Basic Wall : Interior - 4 7/8" Partition',
          },
        },
      ],
    };
  },

  commitAiPlan: async () => {
    const plan = get().aiPlanPreview;
    if (!plan || !plan.commands || plan.commands.length === 0) return;

    try {
      set({ statusMessage: `Executing AI Plan: ${plan.intentSummary}...` });
      await get().executeTransaction(plan.commands, 'ai', plan.intentSummary);
      set({
        aiPlanPreview: null,
        isPromptBarOpen: false,
        statusMessage: `Committed AI Transaction: ${plan.intentSummary}`,
      });
    } catch (e) {
      console.error('Failed to commit AI Plan:', e);
      set({
        statusMessage: `Error executing AI Plan: ${e instanceof Error ? e.message : 'Transaction failed'}`,
      });
    }
  },

  discardAiPlan: () => {
    set({ aiPlanPreview: null });
  },

  // =========================================================================
  // SKETCH MODE SUBSYSTEM (Revit Edit Boundary / Edit Footprint / Create)
  // =========================================================================

  startSketchMode: (mode: 'floor' | 'roof', targetGuid?: string) => {
    let existingPolygon: [number, number][] | null = null;
    let elevation = mode === 'roof' ? 6.0 : 0.0;
    let thickness = mode === 'roof' ? 0.3 : 0.25;
    let pitch = 15.0;
    let targetName = mode === 'roof' ? 'Roof : Pitched Metal Deck' : 'Floor : 10" Concrete Slab';
    let isEditingExisting = false;

    if (targetGuid) {
      isEditingExisting = true;
      const el = get().elements[targetGuid];
      const mesh = get().meshes.find((m) => m.guid === targetGuid);
      if (el) {
        if (el.elevation !== undefined) elevation = el.elevation;
        if (el.thickness !== undefined) thickness = el.thickness;
        if (el.pitch !== undefined) pitch = el.pitch;
        if (el.name) targetName = el.name;
        if (el.polygon && el.polygon.length >= 3) {
          existingPolygon = el.polygon;
        }
      }
      if (!existingPolygon && mesh && mesh.bbox) {
        const { min, max } = mesh.bbox;
        existingPolygon = [
          [min[0], min[1]],
          [max[0], min[1]],
          [max[0], max[1]],
          [min[0], max[1]],
        ];
        if (mesh.name) targetName = mesh.name;
      }
    }

    const lines: SketchLine[] = [];
    if (existingPolygon && existingPolygon.length >= 3) {
      for (let i = 0; i < existingPolygon.length; i++) {
        const next = (i + 1) % existingPolygon.length;
        lines.push({
          id: `sk-${Date.now()}-${i}`,
          start: [existingPolygon[i][0], existingPolygon[i][1]],
          end: [existingPolygon[next][0], existingPolygon[next][1]],
          definesSlope: mode === 'roof',
          slopeAngle: pitch,
          overhang: 0.3,
        });
      }
    }

    set({
      sketchSession: {
        mode,
        elementType: mode,
        isEditingExisting,
        targetGuid,
        targetName,
        elevation,
        thickness,
        pitch,
        lines,
        selectedLineId: null,
        drawTool: 'line',
        defaultDefinesSlope: mode === 'roof',
        defaultSlopeAngle: pitch,
        defaultOverhang: 0.3,
        validationError: null,
      },
      activeTool: 'sketch',
      statusMessage: isEditingExisting
        ? `Sketch Mode: Edit ${mode === 'roof' ? 'Roof Footprint' : 'Floor Boundary'} (${targetName})`
        : `Sketch Mode: Create ${mode === 'roof' ? 'Roof Footprint' : 'Floor Boundary'}`,
    });
  },

  cancelSketchMode: () => {
    set({
      sketchSession: null,
      activeTool: 'select',
      statusMessage: 'Canceled sketch mode',
    });
  },

  finishSketchMode: async () => {
    const { sketchSession, executeTransaction, createSlab, createRoof } = get();
    if (!sketchSession) return false;

    const { lines, mode, isEditingExisting, targetGuid, thickness, elevation, pitch, targetName } = sketchSession;

    if (lines.length < 3) {
      set((s) => ({
        sketchSession: s.sketchSession
          ? { ...s.sketchSession, validationError: 'Boundary must contain at least 3 connected lines.' }
          : null,
      }));
      return false;
    }

    const result = extractPolygonFromLines(lines);
    if (!result.polygon) {
      set((s) => ({
        sketchSession: s.sketchSession
          ? { ...s.sketchSession, validationError: result.error || 'Lines must form a closed loop.' }
          : null,
      }));
      return false;
    }

    const polygon = result.polygon;

    try {
      if (isEditingExisting && targetGuid) {
        await executeTransaction(
          [
            {
              command: 'ElementUpdate',
              params: {
                guid: targetGuid,
                updates: {
                  polygon,
                  thickness,
                  elevation,
                  pitch: mode === 'roof' ? pitch : undefined,
                },
              },
            },
          ],
          'ui',
          `Edit ${mode === 'roof' ? 'Roof Footprint' : 'Floor Boundary'}`
        );
        set({
          statusMessage: `Successfully updated ${targetName || (mode === 'roof' ? 'Roof' : 'Floor')} boundary`,
        });
      } else if (mode === 'floor') {
        await createSlab(polygon, thickness, elevation, targetName || 'Floor : 10" Concrete Slab');
        set({ statusMessage: 'Successfully created Floor slab from sketch' });
      } else if (mode === 'roof') {
        await createRoof(polygon, thickness, elevation, pitch, targetName || 'Roof : Pitched Metal Deck');
        set({ statusMessage: 'Successfully created Roof from sketch' });
      }

      set({
        sketchSession: null,
        activeTool: 'select',
      });
      await get().fetchGeometry();
      await get().fetch2DSlice();
      return true;
    } catch (e: any) {
      console.error('Failed to finish sketch:', e);
      set((s) => ({
        sketchSession: s.sketchSession
          ? { ...s.sketchSession, validationError: e.message || 'Failed to generate 3D geometry from sketch' }
          : null,
      }));
      return false;
    }
  },

  addSketchLine: (start: [number, number], end: [number, number]) => {
    const len = Math.hypot(end[0] - start[0], end[1] - start[1]);
    if (len < 0.05) return;
    set((s) => {
      if (!s.sketchSession) return {};
      const newLine: SketchLine = {
        id: `sk-line-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
        start,
        end,
        definesSlope: s.sketchSession.defaultDefinesSlope,
        slopeAngle: s.sketchSession.defaultSlopeAngle,
        overhang: s.sketchSession.defaultOverhang,
      };
      return {
        sketchSession: {
          ...s.sketchSession,
          lines: [...s.sketchSession.lines, newLine],
          validationError: null,
        },
      };
    });
  },

  addSketchRectangle: (p1: [number, number], p2: [number, number]) => {
    const minX = Math.min(p1[0], p2[0]);
    const maxX = Math.max(p1[0], p2[0]);
    const minY = Math.min(p1[1], p2[1]);
    const maxY = Math.max(p1[1], p2[1]);
    if (maxX - minX < 0.2 || maxY - minY < 0.2) return;

    set((s) => {
      if (!s.sketchSession) return {};
      const defSlope = s.sketchSession.defaultDefinesSlope;
      const slope = s.sketchSession.defaultSlopeAngle;
      const now = Date.now();
      const newLines: SketchLine[] = [
        { id: `sk-r-${now}-1`, start: [minX, minY], end: [maxX, minY], definesSlope: defSlope, slopeAngle: slope },
        { id: `sk-r-${now}-2`, start: [maxX, minY], end: [maxX, maxY], definesSlope: defSlope, slopeAngle: slope },
        { id: `sk-r-${now}-3`, start: [maxX, maxY], end: [minX, maxY], definesSlope: defSlope, slopeAngle: slope },
        { id: `sk-r-${now}-4`, start: [minX, maxY], end: [minX, minY], definesSlope: defSlope, slopeAngle: slope },
      ];
      return {
        sketchSession: {
          ...s.sketchSession,
          lines: [...s.sketchSession.lines, ...newLines],
          validationError: null,
        },
      };
    });
  },

  addSketchFromWall: (wallGuid: string) => {
    const el = get().elements[wallGuid];
    if (!el || !el.start || !el.end) return;
    const s: [number, number] = [el.start[0], el.start[1]];
    const e: [number, number] = [el.end[0], el.end[1]];
    get().addSketchLine(s, e);
  },

  deleteSelectedSketchLine: () => {
    set((s) => {
      if (!s.sketchSession || !s.sketchSession.selectedLineId) return {};
      return {
        sketchSession: {
          ...s.sketchSession,
          lines: s.sketchSession.lines.filter((l) => l.id !== s.sketchSession!.selectedLineId),
          selectedLineId: null,
          validationError: null,
        },
      };
    });
  },

  selectSketchLine: (id: string | null) => {
    set((s) => {
      if (!s.sketchSession) return {};
      return {
        sketchSession: {
          ...s.sketchSession,
          selectedLineId: id,
        },
      };
    });
  },

  updateSketchLine: (id: string, updates: Partial<SketchLine>) => {
    set((s) => {
      if (!s.sketchSession) return {};
      return {
        sketchSession: {
          ...s.sketchSession,
          lines: s.sketchSession.lines.map((l) => (l.id === id ? { ...l, ...updates } : l)),
        },
      };
    });
  },

  setSketchDrawTool: (tool: SketchDrawTool) => {
    set((s) => {
      if (!s.sketchSession) return {};
      return {
        sketchSession: {
          ...s.sketchSession,
          drawTool: tool,
        },
      };
    });
  },

  setSketchParam: (key, value) => {
    set((s) => {
      if (!s.sketchSession) return {};
      return {
        sketchSession: {
          ...s.sketchSession,
          [key]: value,
        },
      };
    });
  },
}));

