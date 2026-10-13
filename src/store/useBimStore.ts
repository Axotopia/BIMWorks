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
} from '../types/bim';
import { UnitSystem } from '../utils/units';

const API_BASE = '/api';

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
  isLegalModalOpen: boolean;
  setLegalModalOpen: (open: boolean) => void;

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

  executeTransaction: (commands: CommandPayload[], origin?: 'ui' | 'ai' | 'script' | 'cli', description?: string) => Promise<any>;
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

  exportOrltProject: () => Promise<void>;
  loadOrltFile: (file: File) => Promise<boolean>;
}

export const useBimStore = create<BimStoreState>((set, get) => ({
  activeRibbonTab: 'Architecture',
  activeTool: 'select',
  keyBuffer: '',
  keyBufferTimeout: null,

  projectName: 'BIMWorks Architectural Project',
  levels: [
    { id: 'lvl-1', name: 'Level 1', elevation: 0.0 },
    { id: 'lvl-2', name: 'Level 2', elevation: 3.0 },
    { id: 'lvl-3', name: 'Roof', elevation: 6.0 },
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

    // Escape cancels tool and clears selection
    if (key === 'Escape') {
      get().clearKeyBuffer();
      set({
        activeTool: 'select',
        selectedGuid: null,
        tempDimension: null,
        alignPickState: { step: null, refGuid: null },
      });
      return;
    }

    // Hotkey lookup table
    const hotkeys: Record<string, () => void> = {
      WA: () => set({ activeTool: 'WA', activeRibbonTab: 'Architecture' }),
      DR: () => set({ activeTool: 'DR', activeRibbonTab: 'Architecture' }),
      WN: () => set({ activeTool: 'WN', activeRibbonTab: 'Architecture' }),
      SB: () => set({ activeTool: 'SB', activeRibbonTab: 'Architecture' }),
      RF: () => set({ activeTool: 'RF', activeRibbonTab: 'Architecture' }),
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
    if (view && view.type === 'floor_plan') {
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

    // Compute dynamic temporary dimension
    const mesh = get().meshes.find((m) => m.guid === guid);
    if (mesh) {
      const min = mesh.bbox.min;
      const max = mesh.bbox.max;
      const center: [number, number, number] = [
        (min[0] + max[0]) / 2,
        (min[1] + max[1]) / 2,
        (min[2] + max[2]) / 2,
      ];

      // Find nearest parallel element to compute witness line distance
      const otherMeshes = get().meshes.filter((m) => m.guid !== guid);
      let nearestDist = 3.6576; // Default ~12'-0"
      let nearestCenter: [number, number, number] = [center[0] - 3.6576, center[1], center[2]];

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

      const feet = Math.floor(nearestDist * 3.28084);
      const inches = Math.round((nearestDist * 3.28084 - feet) * 12);
      const display = `${feet}'-${inches}" (${(nearestDist * 1000).toFixed(0)} mm)`;

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
          axis: 'x',
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

    const delta = newValue - tempDimension.distance;
    await translateElement(tempDimension.elementGuid, delta, 0, 0);
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
      const res = await fetch(`${API_BASE}/constraints/align`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ref_guid: refGuid, target_guid: targetGuid, axis, lock }),
      });
      if (res.ok) {
        await get().fetchConstraints();
        await get().fetchGeometry();
        await get().fetch2DSlice();
        set({ alignPickState: { step: null, refGuid: null }, activeTool: 'select' });
      }
    } catch (e) {
      console.error('Failed to create align constraint', e);
    }
  },

  toggleConstraintLock: async (constraintId: string, isLocked: boolean) => {
    try {
      const res = await fetch(`${API_BASE}/constraints/${constraintId}/toggle_lock`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_locked: isLocked }),
      });
      if (res.ok) {
        await get().fetchConstraints();
      }
    } catch (e) {
      console.error('Failed to toggle constraint lock', e);
    }
  },

  lockDimension: async (guidA: string, guidB: string, distance?: number, axis = 'x') => {
    try {
      const res = await fetch(`${API_BASE}/constraints/lock_dimension`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          guid_a: guidA,
          guid_b: guidB,
          locked_distance: distance,
          lock: true,
          axis,
        }),
      });
      if (res.ok) {
        await get().fetchConstraints();
      }
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
      const res = await fetch(`${API_BASE}/constraints/equalize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          span_start_guid: spanStartGuid,
          span_end_guid: spanEndGuid,
          interior_guids: interiorGuids,
          axis,
        }),
      });
      if (res.ok) {
        await get().fetchConstraints();
        await get().fetchGeometry();
        await get().fetch2DSlice();
      }
    } catch (e) {
      console.error('Failed to equalize span', e);
    }
  },

  deleteConstraint: async (constraintId: string) => {
    try {
      const res = await fetch(`${API_BASE}/constraints/${constraintId}`, { method: 'DELETE' });
      if (res.ok) {
        await get().fetchConstraints();
      }
    } catch (e) {
      console.error('Failed to delete constraint', e);
    }
  },

  equalizeSouthWallWindows: async () => {
    const { meshes } = get();
    const windows = meshes.filter((m) => m.ifc_class === 'IfcWindow');
    const walls = meshes.filter((m) => m.ifc_class === 'IfcWallStandardCase');
    if (windows.length >= 2 && walls.length > 0) {
      const southWall = walls[0];
      await get().equalizeSpan(
        southWall.guid,
        southWall.guid,
        windows.map((w) => w.guid),
        'x'
      );
    }
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
        set({
          meshes: data.meshes || [],
          levels: data.levels || get().levels,
          grids: data.grids || get().grids,
        });
      }
    } catch (e) {
      console.error('Failed to fetch geometry', e);
    }
  },

  fetch2DSlice: async (cutElevation = 1.2) => {
    try {
      const res = await fetch(`${API_BASE}/slice/2d?cut_elevation=${cutElevation}`);
      if (res.ok) {
        const data = await res.json();
        set({ sliced2D: data });
      }
    } catch (e) {
      console.error('Failed to fetch 2D slice', e);
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
        });
        await get().fetchGeometry();
        await get().fetch2DSlice();
        await get().fetchProjectState();
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
      const res = await fetch(`${API_BASE}/wall`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ start, end, height: 3.0, thickness: 0.25, name }),
      });
      if (res.ok) {
        await get().fetchGeometry();
        await get().fetch2DSlice();
        set({ activeTool: 'select' });
      }
    } catch (e) {
      console.error('Failed to create wall', e);
    }
  },

  createDoor: async (hostWallGuid, offset, name = 'Single Flush : 36" x 84"') => {
    try {
      const res = await fetch(`${API_BASE}/door`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ host_wall_guid: hostWallGuid, offset_along_wall: offset, name }),
      });
      if (res.ok) {
        await get().fetchGeometry();
        await get().fetch2DSlice();
        set({ activeTool: 'select' });
      }
    } catch (e) {
      console.error('Failed to insert door', e);
    }
  },

  createWindow: async (hostWallGuid, offset, name = 'Fixed Window : 48" x 48"') => {
    try {
      const res = await fetch(`${API_BASE}/window`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          host_wall_guid: hostWallGuid,
          offset_along_wall: offset,
          width: 1.4,
          height: 1.5,
          sill_height: 0.9,
          name,
        }),
      });
      if (res.ok) {
        await get().fetchGeometry();
        await get().fetch2DSlice();
        set({ activeTool: 'select' });
      }
    } catch (e) {
      console.error('Failed to insert window', e);
    }
  },

  deleteElement: async (guid) => {
    try {
      const res = await fetch(`${API_BASE}/element/${guid}`, { method: 'DELETE' });
      if (res.ok) {
        set({ selectedGuid: null, tempDimension: null });
        await get().fetchGeometry();
        await get().fetch2DSlice();
      }
    } catch (e) {
      console.error('Failed to delete element', e);
    }
  },

  translateElement: async (guid, dx, dy, dz = 0.0) => {
    try {
      const res = await fetch(`${API_BASE}/element/${guid}/translate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dx, dy, dz }),
      });
      if (res.ok) {
        await get().fetchGeometry();
        await get().fetch2DSlice();
      }
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

  exportOrltProject: async () => {
    try {
      set({ statusMessage: 'Exporting .orlt Hybrid Project Container...' });
      const res = await fetch(`${API_BASE}/project/export-orlt`);
      if (res.ok) {
        const blob = await res.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const pName = get().projectName.replace(/[^a-zA-Z0-9_-]/g, '_') || 'BIMWorks_Project';
        a.download = `${pName}.orlt`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        window.URL.revokeObjectURL(url);
        set({ statusMessage: `Exported ${pName}.orlt (Hybrid Container)` });
      }
    } catch (e) {
      console.error('Failed to export .orlt project', e);
      set({ statusMessage: 'Error exporting .orlt project' });
    }
  },

  loadOrltFile: async (file: File) => {
    set({ isLoadingFile: true, statusMessage: `Unpacking .orlt hybrid container: ${file.name}...` });
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch(`${API_BASE}/project/load-orlt`, {
        method: 'POST',
        body: formData,
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: 'Network error' }));
        set({
          isLoadingFile: false,
          statusMessage: `Error loading .orlt: ${err.detail || 'Failed to unpack'}`,
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
        statusMessage: `Successfully loaded ${file.name} (v2.1 Hybrid Container)`,
      });
      return true;
    } catch (e) {
      console.error('Error in loadOrltFile:', e);
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

  setWallJoin: async (wallGuid, endIdx, allowJoin, mode) => {
    try {
      const res = await fetch(`${API_BASE}/wall/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          wall_guid: wallGuid,
          end_index: endIdx,
          allow_join: allowJoin,
          mode: mode,
        }),
      });
      if (res.ok) {
        await get().fetchWallJoins();
        await get().fetch2DSlice();
      }
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
      await get().fetchProjectState();
      await get().fetchGeometry();
      await get().fetch2DSlice();
      await get().fetchConstraints();
      await get().fetchTransactionJournal();

      return data;
    } catch (e) {
      console.error('executeTransaction error:', e);
      throw e;
    }
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
      const wM = wFeet * 0.3048;
      const dM = dFeet * 0.3048;

      return {
        intentSummary: `Create ${wFeet}' × ${dFeet}' perimeter wall enclosure (4 walls with Butt joins)`,
        commands: [
          {
            command: 'WallCreate',
            params: {
              start: [0, 0, 0],
              end: [wM, 0, 0],
              height: 3.0,
              thickness: 0.25,
              name: 'Basic Wall : Exterior - 10" CMU',
            },
          },
          {
            command: 'WallCreate',
            params: {
              start: [wM, 0, 0],
              end: [wM, dM, 0],
              height: 3.0,
              thickness: 0.25,
              name: 'Basic Wall : Exterior - 10" CMU',
            },
          },
          {
            command: 'WallCreate',
            params: {
              start: [wM, dM, 0],
              end: [0, dM, 0],
              height: 3.0,
              thickness: 0.25,
              name: 'Basic Wall : Exterior - 10" CMU',
            },
          },
          {
            command: 'WallCreate',
            params: {
              start: [0, dM, 0],
              end: [0, 0, 0],
              height: 3.0,
              thickness: 0.25,
              name: 'Basic Wall : Exterior - 10" CMU',
            },
          },
        ],
      };
    }

    // Pattern 2: Door insertion: "insert door" or "add door at 10 feet"
    if (text.includes('door')) {
      // Find host wall
      const wallGuids = Object.keys(elements).filter(
        (g) => elements[g].ifc_class === 'IfcWallStandardCase' || elements[g].ifc_class === 'IfcWall'
      );
      const targetWall = selectedGuid && wallGuids.includes(selectedGuid) ? selectedGuid : wallGuids[0];

      if (!targetWall) {
        throw new Error('No wall available to host the door. Create walls first.');
      }

      const offsetMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:'|ft|feet|m)?/);
      const offsetVal = offsetMatch ? parseFloat(offsetMatch[1]) * 0.3048 : 3.0;

      return {
        intentSummary: `Insert 36" × 84" Single Flush Door into host wall at ${offsetVal.toFixed(1)}m`,
        affectedGuids: [targetWall],
        commands: [
          {
            command: 'DoorInsert',
            params: {
              host_wall_guid: targetWall,
              offset_along_wall: offsetVal,
              width: 0.95,
              height: 2.13,
              name: 'Single Flush : 36" x 84"',
              swing_flipped: text.includes('flip'),
            },
          },
        ],
      };
    }

    // Pattern 3: Window insertion: "insert window" or "add 48x48 window"
    if (text.includes('window')) {
      const wallGuids = Object.keys(elements).filter(
        (g) => elements[g].ifc_class === 'IfcWallStandardCase' || elements[g].ifc_class === 'IfcWall'
      );
      const targetWall = selectedGuid && wallGuids.includes(selectedGuid) ? selectedGuid : wallGuids[0];

      if (!targetWall) {
        throw new Error('No wall available to host window.');
      }

      return {
        intentSummary: 'Insert 48" × 48" Fixed Window into wall',
        affectedGuids: [targetWall],
        commands: [
          {
            command: 'WindowInsert',
            params: {
              host_wall_guid: targetWall,
              offset_along_wall: 2.5,
              width: 1.2,
              height: 1.2,
              sill_height: 0.9,
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
              thickness: 0.25,
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
            height: 3.0,
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
}));

