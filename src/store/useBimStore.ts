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
} from '../types/bim';

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
  createWall: (start: [number, number, number], end: [number, number, number], name?: string) => Promise<void>;
  createDoor: (hostWallGuid: string, offset: number, name?: string) => Promise<void>;
  createWindow: (hostWallGuid: string, offset: number, name?: string) => Promise<void>;
  deleteElement: (guid: string) => Promise<void>;
  translateElement: (guid: string, dx: number, dy: number, dz?: number) => Promise<void>;
  updateGeoreferencing: (data: BimStoreState['georeference']) => Promise<void>;
  addViewportToSheet: (sheetId: string, viewId: string, x: number, y: number) => void;
  exportSheetPdf: (sheetId: string, svgContent: string) => Promise<void>;
  exportIfc: () => Promise<void>;
}

export const useBimStore = create<BimStoreState>((set, get) => ({
  activeRibbonTab: 'Architecture',
  activeTool: 'select',
  keyBuffer: '',
  keyBufferTimeout: null,

  projectName: 'OpenRevitLT Architectural Project',
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
      projectName: 'OpenRevitLT Prototype House',
      date: '2026-10-13',
      drawnBy: 'ORLT Architect',
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
      projectName: 'OpenRevitLT Prototype House',
      date: '2026-10-13',
      drawnBy: 'ORLT Architect',
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

  activeScale: '1/4" = 1\'-0"',
  activeDetailLevel: 'medium',
  activeVisualStyle: 'consistent_colors',

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
      const res = await fetch(`${API_BASE}/sample`, { method: 'POST' });
      if (res.ok) {
        await get().fetchGeometry();
        await get().fetch2DSlice();
      }
    } catch (e) {
      console.error('Failed to load sample building', e);
    }
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
        a.download = 'OpenRevitLT_Project.ifc';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        window.URL.revokeObjectURL(url);
      }
    } catch (e) {
      console.error('Failed to export IFC', e);
    }
  },
}));
