import { create } from 'zustand';
import {
  ActiveTool,
  RibbonTab,
  BimElement,
  BimType,
  LevelData,
  GridData,
  MeshBufferData,
  Sliced2DData,
  ViewDefinition,
  SheetDefinition,
  SheetPaperSize,
  TemporaryDimension,
  SheetViewport,
  SheetAnnotation,
  SheetRevision,
  DraftingLayer,
  LayerGroup,
  TextStyle,
  DimensionStyle,
  ParametricConstraint,
  WallJoinState,
  CommandPayload,
  AiPlan,
  TransactionJournalEntry,
  SketchSession,
  SketchLine,
  SketchDrawTool,
  PlaneLockType,
  CameraProjectionMode,
  DraftEntity,
} from '../types/bim';
import {
  calculateMeshVolume,
  calculateMeshArea,
} from '../interaction/directModeling';
import {
  DEFAULT_DRAFTING_LAYERS,
  DEFAULT_LAYER_GROUPS,
  DEFAULT_TEXT_STYLES,
  DEFAULT_DIMENSION_STYLES,
} from '../components/sheets/annotationStyles';
import { draftingFrame } from '../components/sheets/annotationEngine';
import { DEFAULT_DRAFT_ENTITIES } from '../components/drafting/defaultDraftEntities';
import { UnitSystem, formatLength, tryParseLength } from '../utils/units';
import {
  InteractionSessionState,
  InteractionAction,
  createInitialSession,
  interactionReducer,
} from '../interaction/session';

const API_BASE = '/api';

/**
 * UI-P0-6: the single name for the cross-viewport Zoom Extents request. It was
 * spelled `orlt-zoom-extents` — the pre-rename prototype name — in three places,
 * and only the 3D viewport listened, so `ZE` silently did nothing in a plan view.
 */
export const ZOOM_EXTENTS_EVENT = 'bimworks-zoom-extents';
export const TILE_WINDOWS_EVENT = 'bimworks-tile-windows';
export const TAB_VIEWS_EVENT = 'bimworks-tab-views';

/**
 * UI-P0-10/UI-P0-11: interaction state that lives inside a viewport component
 * (an in-progress wall start point, a first box corner, a pending sketch point,
 * an open dimension editor) cannot be reset by the store directly. Instead the
 * store bumps a counter and every viewport clears its own in-progress state when
 * it changes. One cancel path, no duplicate Escape listeners.
 *
 * `reason` is carried for debugging only — the viewports clear everything either
 * way, because a half-cleared editor is how a stale first point ends up
 * completing a wall the user thought they had cancelled.
 */
export type InteractionResetReason = 'escape' | 'tool-change' | 'sketch-cancel' | 'sketch-finish';

/**
 * UI-P0-3: every mutation wrapper used to be `catch (e) { console.error(...) }`,
 * so a rejected command was invisible: the click did nothing and the status bar
 * still said "Ready". A user cannot tell a validation refusal from a bug from a
 * dead button. This reports the engine's own message (FastAPI puts the reason in
 * `detail`) into the status bar and returns it for callers that want to react.
 */
function failureMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  return 'Command failed';
}

/**
 * Turns an HTTP error body from the FastAPI sidecar into one readable line.
 * Handles both shapes it actually produces: a plain string, and a Pydantic
 * `detail` list of `{ loc, msg }` objects. Returns a non-empty string always.
 */
function describeApiError(detail: unknown): string {
  if (typeof detail === 'string' && detail.trim()) return detail;
  if (Array.isArray(detail)) {
    const parts = detail.map((item) => {
      if (typeof item === 'string') return item;
      if (item && typeof item === 'object') {
        const rec = item as { loc?: unknown[]; msg?: string; type?: string };
        const field = Array.isArray(rec.loc) ? rec.loc.filter((p) => p !== 'body').join('.') : '';
        const msg = rec.msg || rec.type || 'invalid';
        return field ? `${field}: ${msg}` : msg;
      }
      return String(item);
    });
    if (parts.length) return parts.join('; ');
  }
  if (detail && typeof detail === 'object') {
    const rec = detail as { msg?: string; message?: string };
    if (rec.msg) return rec.msg;
    if (rec.message) return rec.message;
  }
  return 'Transaction failed';
}


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
  moveReference: 'ReferenceMove',
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
  // P6 sheet & viewport commands (bus-backed, journaled, undoable)
  createSheet: 'SheetCreate',
  deleteSheet: 'SheetDelete',
  updateSheet: 'SheetUpdate',
  addViewportToSheet: 'ViewportAdd',
  removeViewportFromSheet: 'ViewportRemove',
  moveViewport: 'ViewportMove',
  // Phase 2 dimension-driven editing commands
  createDimension: 'DimensionCreate',
  setDimensionValue: 'DimensionValueSet',
  deleteDimension: 'DimensionDelete',
  toggleDimensionLock: 'DimensionLockToggle',
  // Phase 5 type commands
  setElementType: 'ElementSetType',
  updateType: 'TypeUpdate',
  duplicateType: 'TypeDuplicate',
  // Direct manipulation typed commands
  modifyWallHeight: 'WallSetHeight',
  modifyWallThickness: 'WallSetThickness',
  modifyWallEnd: 'WallSetEnd',
  modifyOpeningOffset: 'OpeningSetOffset',
  modifyOpeningWidth: 'OpeningSetWidth',
  modifyOpeningSillHeight: 'OpeningSetSillHeight',
  flipOpening: 'OpeningFlip',
  modifyGridEndpoint: 'GridSetEndpoint',
  modifyPolygonVertex: 'PolygonSetVertex',
} as const;

export type UiAction = keyof typeof UI_ACTION_COMMANDS;

// ---------------------------------------------------------------------------
// Post-commit refresh: one round trip, and two numbers that cannot be confused.
// See docs/SPECIFICATION-v0.2.md §6.3 (delta push) and §6.4 (instrumentation).
// ---------------------------------------------------------------------------

/**
 * The single implementation of "apply an engine geometry payload". Both
 * fetchGeometry() and fetchStateBundle() go through it, so the two paths cannot
 * drift. The `elements` record is built from each mesh's `params`, not from the
 * tessellation: baselines, host GUIDs and offset_along_wall exist only in the
 * parametric payload.
 */
function geometryPatch(
  data: any,
  current: { levels: BimStoreState['levels']; grids: BimStoreState['grids'] }
): Partial<BimStoreState> {
  const meshes: MeshBufferData[] = data.meshes || [];
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
      polygon: params.polygon,
      elevation: params.elevation,
      pitch: params.pitch,
      tag: params.tag,
      type_properties: params.type_properties,
      type_id: params.type_id,
    };
  }
  return {
    meshes,
    elements,
    levels: data.levels || current.levels,
    grids: data.grids || current.grids,
  };
}

function normalizeView(v: any): ViewDefinition {
  const vr = v.viewRange || v.view_range || {};
  return {
    id: v.id,
    name: v.name,
    type: v.type ?? 'floor_plan',
    levelId: v.levelId ?? v.level_id,
    scale: v.scale ?? '1/4" = 1\'-0"',
    detailLevel: v.detailLevel ?? v.detail_level ?? 'medium',
    visualStyle: v.visualStyle ?? v.visual_style ?? 'hidden_line',
    viewRange: {
      top: Number(vr.top ?? 8.0),
      cut: Number(vr.cut ?? 4.0),
      bottom: Number(vr.bottom ?? 0.0),
      viewDepth: Number(vr.viewDepth ?? vr.view_depth ?? 0.0),
    },
    ...(v.sectionBox ? { sectionBox: v.sectionBox } : {}),
  };
}

/**
 * Resolves the active view's 2D request context. Shared by fetch2DSlice() and
 * fetchStateBundle() so the two cannot route a section as a plan.
 *
 * Plans are LEVEL-RELATIVE: `cut` is a height above the storey, not an absolute
 * elevation - the Revit convention, and the only thing that works on a real model
 * (a storey at 1824 ft cut at an absolute 4 ft sections empty space).
 */
function sliceContext(
  views: BimStoreState['views'],
  activeViewId: BimStoreState['activeViewId'],
  cutElevation?: number
) {
  const active = views.find((v) => v.id === activeViewId);
  const range = active?.viewRange ?? (active as any)?.view_range;
  return {
    viewType: active?.type ?? 'floor_plan',
    cut: cutElevation ?? range?.cut ?? 4.0,
    levelId: active?.levelId ?? (active as any)?.level_id,
    top: range?.top,
    bottom: range?.bottom,
    viewDepth: range?.viewDepth ?? range?.view_depth,
  };
}

const REFRESH_LIMIT = 100;
const REFRESH_SAMPLES: { clientMs: number; engineMs: number | null }[] = [];

/** Set once if the engine has no /api/state. A 404 is definitive, so we stop
 *  paying a failed request on every commit. Other failures stay retryable. */
let bundleUnsupported = false;

/** Section failures already surfaced, keyed by section + message, so a
 *  persistently failing section logs once instead of once per commit. */
const reportedSectionErrors = new Set<string>();

/**
 * The pre-bundle refresh path, retained as a fallback and run in PARALLEL.
 * A bundle failure must not become a slow path.
 */
async function refreshIndividually(
  getState: () => BimStoreState,
  cutElevation?: number
): Promise<void> {
  await Promise.all([
    getState().fetchProjectState(),
    getState().fetchConstraints(),
    getState().fetchGeometry(),
    getState().fetchWallJoins(),
    getState().fetch2DSlice(cutElevation),
    getState().fetchTransactionJournal(),
    getState().fetchTypes(),
  ]);
}

/** Records one refresh. `clientMs` is what the user waits for; `engineMs` is
 *  engine compute only, and the two are never averaged together. */
function recordRefresh(clientMs: number, engineMs: number | null | undefined) {
  REFRESH_SAMPLES.push({ clientMs, engineMs: engineMs ?? null });
  if (REFRESH_SAMPLES.length > REFRESH_LIMIT) REFRESH_SAMPLES.shift();
  (globalThis as any).__bimworksRefresh = refreshStats();
}

function pctOf(values: number[], p: number): number {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

/** Rolling refresh statistics, separable by kind. Reachable at runtime as
 *  `globalThis.__bimworksRefresh` so a measurement needs no bundler change. */
export function refreshStats() {
  const n = REFRESH_SAMPLES.length;
  if (!n) {
    return { samples: 0, bundleSupported: !bundleUnsupported, client: null, engine: null };
  }
  const c = REFRESH_SAMPLES.map((s) => s.clientMs);
  const e = REFRESH_SAMPLES
    .map((s) => s.engineMs)
    .filter((v): v is number => v !== null && v !== undefined);
  return {
    samples: n,
    bundleSupported: !bundleUnsupported,
    client: { p50: pctOf(c, 50), p95: pctOf(c, 95), max: Math.max(...c) },
    engine: e.length
      ? { p50: pctOf(e, 50), p95: pctOf(e, 95), max: Math.max(...e) }
      : null,
  };
}

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
        error: `Open boundary detected: segment at (${formatLength(currentEnd[0])}, ${formatLength(currentEnd[1])}) does not connect to another line. All magenta lines must form a continuous closed loop.`,
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
      error: `Boundary loop is not closed (gap between start and end is ${formatLength(dist(currentEnd, loopStart))}). Close the loop by snapping to the starting point.`,
    };
  }

  return { polygon: poly, error: null };
}

interface BimStoreState {
  // Navigation & Tools
  activeRibbonTab: RibbonTab;
  activeTool: ActiveTool;
  keyBuffer: string;
  keyBufferTimeout: any;
  /**
   * Bumped whenever in-progress interaction state held inside a viewport must be
   * discarded (Escape, a tool change, or ending a sketch session). See
   * `InteractionResetReason`.
   */
  interactionResetToken: number;
  interactionResetReason: InteractionResetReason | null;
  resetInteraction: (reason: InteractionResetReason) => void;
  /**
   * UI-P0-1: Revit keeps a placement tool armed until you cancel it, so you draw
   * N walls from N+1 clicks. BIMWorks ended every placement by switching back to
   * `select`, making a room cost one ribbon click per wall. `chainTools` defaults
   * to that Revit behaviour; the Options Bar (UI-P3) will expose it per command.
   */
  chainTools: boolean;
  setChainTools: (enabled: boolean) => void;
  /** Applied after a placement completes; honours `chainTools` (UI-P0-1). */
  completePlacement: () => void;
  /**
   * Unified Interaction Session (Track B Phase 1)
   */
  interactionSession: InteractionSessionState;
  dispatchInteraction: (action: InteractionAction) => void;
  /**
   * UI-P0-9: the Delete/Backspace key. Lives here rather than in `App.tsx` so the
   * sketch-vs-model decision is in one place and is unit-testable.
   */
  handleDeleteKey: () => void;

  // Views & Sheets
  views: ViewDefinition[];
  activeViewId: string;
  sheets: SheetDefinition[];
  activeSheetId: string;
  viewLayout: 'split-2v' | 'split-2h' | 'quad' | 'single-3d' | 'single-2d' | 'tabs';
  setViewLayout: (layout: 'split-2v' | 'split-2h' | 'quad' | 'single-3d' | 'single-2d' | 'tabs') => void;
  cycleViewLayout: () => void;

  // Sheet Drafting Layers & Annotations (Phase 2)
  draftingLayers: DraftingLayer[];
  layerGroups: LayerGroup[];
  textStyles: TextStyle[];
  dimensionStyles: DimensionStyle[];
  activeAnnotationTool: 'select' | 'text' | 'leader' | 'dimension' | 'line';
  activeLayerId: string;
  activeTextStyleId: string;
  activeDimensionStyleId: string;
  selectedAnnotationId: string | null;
  draftEntities: DraftEntity[];

  // Model Data
  rev?: number;
  docId?: string;
  projectName: string;
  levels: LevelData[];
  elements: Record<string, BimElement>;
  meshes: MeshBufferData[];
  grids: GridData[];
  sliced2D: Sliced2DData | null;

  // 1D/2D Parametric Constraints
  constraints: ParametricConstraint[];
  alignPickState: { step: 'pick_ref' | 'pick_target' | null; refGuid: string | null };
  trimPickState: { step: 'pick_second' | null; firstGuid: string | null; firstPoint: [number, number] | null };

  // Selection & Properties
  selectedGuid: string | null;
  selectedGuids: string[];
  hoveredGuid: string | null;
  hoverCandidates: string[];
  snapsEnabled: boolean;

  // Direct 3D Modeling (IngeTrazo / SketchUp format)
  planeLock: PlaneLockType;
  setPlaneLock: (lock: PlaneLockType) => void;
  tagSelectedElement: (targetClass: 'IfcWall' | 'IfcSlab' | 'IfcColumn' | 'IfcRoof') => Promise<void>;
  addModelMesh: (mesh: MeshBufferData, element?: Partial<BimElement>) => void;
  updateModelMesh: (guid: string, updates: Partial<MeshBufferData>) => void;

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
  setActiveRibbonTab: (tab: RibbonTab) => void;
  setActiveTool: (tool: ActiveTool, ribbonTab?: RibbonTab) => void;
  handleKeyStroke: (key: string) => void;
  clearKeyBuffer: () => void;

  setActiveViewId: (id: string) => void;
  addView: (view: ViewDefinition) => void;
  /** Assigns the storey a 2D view draws, then refetches it. */
  setViewLevel: (viewId: string, levelId: string | undefined) => void;
  /** Sets the cut plane as a height ABOVE the view's level, then refetches. */
  setViewCut: (viewId: string, cutAboveLevel: number) => void;
  setActiveSheetId: (id: string) => void;
  setSelectedGuid: (guid: string | null) => void;
  setSelectedGuids: (guids: string[]) => void;
  setHoveredGuid: (guid: string | null) => void;
  setHoverCandidates: (guids: string[]) => void;
  cycleTabSelection: () => void;
  toggleSnaps: () => void;

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
  cameraProjection: CameraProjectionMode;
  setCameraProjection: (mode: CameraProjectionMode) => void;
  toggleCameraProjection: () => void;

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
  setTrimPickState: (state: { step: 'pick_second' | null; firstGuid: string | null; firstPoint: [number, number] | null }) => void;
  trimExtendWall: (guid: string, endIndex: number, targetGuid: string, cornerMode?: boolean, targetEndIndex?: number) => Promise<void>;
  splitWall: (guid: string, atOffset: number, gap?: number) => Promise<void>;
  deleteConstraint: (constraintId: string) => Promise<void>;
  equalizeSouthWallWindows: () => Promise<void>;
  setDimensionValue: (dimensionId: string, value: number, anchor?: 'start' | 'end' | 'center') => Promise<void>;
  createDimension: (params: {
    ref_a: { guid: string; ref?: string; point?: [number, number] };
    ref_b: { guid: string; ref?: string; point?: [number, number] };
    kind?: 'aligned' | 'linear' | 'angular' | 'radial';
    axis?: 'x' | 'y' | 'aligned';
    offset?: number;
    value?: number;
    is_locked?: boolean;
    eq_group?: string;
  }) => Promise<void>;
  deleteDimension: (dimensionId: string) => Promise<void>;
  toggleDimensionLock: (dimensionId: string, isLocked: boolean) => Promise<void>;
  undo: () => Promise<void>;
  redo: () => Promise<void>;

  // Phase 5 type management
  types: BimType[];
  fetchTypes: () => Promise<void>;
  setElementType: (guid: string, typeId: string) => Promise<void>;
  updateType: (typeId: string, parameters: Record<string, any>) => Promise<void>;
  duplicateType: (sourceTypeId: string, newTypeId: string, newName: string) => Promise<void>;

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
  modifyWallHeight: (guid: string, height: number) => Promise<void>;
  modifyWallThickness: (guid: string, thickness: number) => Promise<void>;
  modifyWallEnd: (guid: string, end: 'start' | 'end', point: [number, number] | [number, number, number], clamp?: boolean) => Promise<void>;
  modifyOpeningOffset: (guid: string, offset: number, clamp?: boolean) => Promise<void>;
  modifyOpeningWidth: (guid: string, width: number) => Promise<void>;
  modifyOpeningSillHeight: (guid: string, sillHeight: number) => Promise<void>;
  flipOpening: (guid: string) => Promise<void>;
  modifyGridEndpoint: (guid: string, end: 'start' | 'end', point: [number, number]) => Promise<void>;
  modifyPolygonVertex: (guid: string, vertexIndex: number, point: [number, number]) => Promise<void>;
  moveReference: (source: any, target: any, axis?: string) => Promise<void>;
  updateGeoreferencing: (data: BimStoreState['georeference']) => Promise<void>;
  createSheet: (sheetNumber: string, sheetTitle: string, paperSize?: SheetPaperSize, orientation?: 'landscape' | 'portrait') => Promise<void>;
  deleteSheet: (sheetId: string) => Promise<void>;
  updateSheet: (sheetId: string, updates: Partial<SheetDefinition>) => Promise<void>;
  updateViewportScale: (viewportId: string, scaleFactor: number, sheetId?: string) => Promise<void>;
  addViewportToSheet: (sheetId: string, viewId: string, x: number, y: number) => Promise<void>;
  removeViewportFromSheet: (viewportId: string, sheetId?: string) => Promise<void>;
  moveViewport: (viewportId: string, x: number, y: number, sheetId?: string) => Promise<void>;
  exportSheetPdf: (sheetId: string, svgContent: string) => Promise<void>;
  exportBatchPdf: (sheetsData: Array<{ sheetName: string; svgContent: string }>, filename?: string) => Promise<void>;
  exportIfc: () => Promise<void>;

  // Sheet Drafting & Annotation Actions (Phase 2 & 3)
  setActiveAnnotationTool: (tool: 'select' | 'text' | 'leader' | 'dimension' | 'line') => void;
  setActiveLayerId: (id: string) => void;
  setActiveTextStyleId: (id: string) => void;
  setActiveDimensionStyleId: (id: string) => void;
  setSelectedAnnotationId: (id: string | null) => void;
  addSheetAnnotation: (sheetId: string, annotation: Omit<SheetAnnotation, 'id'>) => Promise<void>;
  updateSheetAnnotation: (sheetId: string, annotationId: string, updates: Partial<SheetAnnotation>) => Promise<void>;
  removeSheetAnnotation: (sheetId: string, annotationId: string) => Promise<void>;
  duplicateSheet: (sheetId: string) => Promise<string | null>;
  addSheetRevision: (sheetId: string, revision: Omit<SheetRevision, 'id'>) => Promise<void>;
  updateSheetRevision: (sheetId: string, revId: string, patch: Partial<SheetRevision>) => Promise<void>;
  removeSheetRevision: (sheetId: string, revId: string) => Promise<void>;
  dimAllViewport: (sheetId: string, viewportId: string) => Promise<void>;
  addDraftingLayer: (layer: DraftingLayer) => void;
  updateDraftingLayer: (layerId: string, updates: Partial<DraftingLayer>) => void;
  deleteDraftingLayer: (layerId: string) => void;
  addLayerGroup: (group: LayerGroup) => void;
  updateLayerGroup: (groupId: string, updates: Partial<LayerGroup>) => void;
  setDraftEntities: (entities: DraftEntity[]) => void;
  createDraftingView: (name: string, scale?: string, scaleDenominator?: number) => string;
  deleteDraftingView: (viewId: string) => void;
  addDraftEntity: (entity: Omit<DraftEntity, 'id'>) => string;
  updateDraftEntity: (id: string, updates: Partial<DraftEntity>) => void;
  removeDraftEntity: (id: string) => void;

  // Wall & Modeling Tool Options (Options Bar)
  wallHeight: number;
  wallLocationLine: 'centerline' | 'core_centerline' | 'exterior' | 'interior';
  wallOffset: number;
  wallLevelId: string | null;
  setWallHeight: (height: number) => void;
  setWallLocationLine: (loc: 'centerline' | 'core_centerline' | 'exterior' | 'interior') => void;
  setWallOffset: (offset: number) => void;
  setWallLevelId: (levelId: string | null) => void;

  createSimilar: () => void;
  flipElementOrientation: (guid: string) => Promise<void>;
  selectAllInstances: (categoryOrClass: string, onlyInActiveView?: boolean) => void;

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
  moveLevel: (levelId: string, elevation: number) => Promise<void>;

  executeTransaction: (commands: CommandPayload[], origin?: 'ui' | 'ai' | 'script' | 'cli', description?: string) => Promise<any>;
  /**
   * P1: the single mutation entry point for UI actions. Wraps one typed command
   * in an atomic, journaled transaction and refreshes view state from the
   * engine. Any mutation that does not go through here is a bug.
   */
  dispatchTransaction: (action: UiAction, params: Record<string, unknown>, description?: string) => Promise<any>;
  activeDragSessionId: string | null;
  beginDrag: (description?: string) => Promise<string>;
  endDrag: (commit?: boolean) => Promise<any>;
  lastGestureCommit: {
    action: UiAction;
    params: Record<string, any>;
    paramKey: string;
    guid: string;
  } | null;
  setLastGestureCommit: (commit: BimStoreState['lastGestureCommit']) => void;
  retypeCommittedValue: (rawInput: string) => Promise<boolean>;
  undoTransaction: () => Promise<void>;
  redoTransaction: () => Promise<void>;
  transactionJournal: TransactionJournalEntry[];
  fetchTransactionJournal: () => Promise<void>;

  /**
   * Refreshes every read-model the UI holds in ONE round trip. Replaces the
   * sequence of up-to-seven serial fetches that ran after each commit, and is
   * the only post-commit refresh path.
   */
  fetchStateBundle: (cutElevation?: number) => Promise<void>;

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

// UI-P0-5: view-range offsets are DECIMAL FEET, which is what the engine, the
// `/api/slice/2d` route (default 4.0) and the View Range dialog all use. The seeds
// here were the old metre numbers (2.3 / 1.2 / 0) left over from before the units
// boundary landed, so the app's own default plan cut 1.2 ft above the floor —
// below the 6 ft not-cut rule, i.e. below every door head — while the dialog and
// the backend both said 4 ft. One number, three components, and the lowest won.
const DEFAULT_VIEW_RANGE = { top: 8.0, cut: 4.0, bottom: 0.0, viewDepth: 0.0 } as const;
const ROOF_VIEW_RANGE = { top: 30.0, cut: 20.0, bottom: 0.0, viewDepth: 0.0 } as const;

let activeDragTracking: { action?: UiAction; params?: Record<string, any>; guid?: string; paramKey?: string } | null = null;
let pendingBeginDragPromise: Promise<string | null> | null = null;
let cancelPendingBeginDrag = false;

export const useBimStore = create<BimStoreState>((set, get) => ({
  activeRibbonTab: 'Architecture',
  activeTool: 'select',
  keyBuffer: '',
  keyBufferTimeout: null,
  interactionResetToken: 0,
  interactionResetReason: null,
  chainTools: true,
  setChainTools: (enabled) => set({ chainTools: enabled }),

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
      viewRange: { ...DEFAULT_VIEW_RANGE },
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
      viewRange: { ...DEFAULT_VIEW_RANGE },
    },
    {
      id: 'view-level-2',
      name: 'Floor Plan: Level 2',
      type: 'floor_plan',
      levelId: 'lvl-2',
      scale: '1/4" = 1\'-0"',
      detailLevel: 'medium',
      visualStyle: 'hidden_line',
      viewRange: { ...DEFAULT_VIEW_RANGE },
    },
    {
      id: 'view-roof-plan',
      name: 'Roof Plan',
      type: 'floor_plan',
      levelId: 'lvl-roof',
      scale: '1/4" = 1\'-0"',
      detailLevel: 'medium',
      visualStyle: 'hidden_line',
      viewRange: { ...ROOF_VIEW_RANGE },
    },
    {
      id: 'view-section-1',
      name: 'Building Section 1',
      type: 'section',
      scale: '1/4" = 1\'-0"',
      detailLevel: 'fine',
      visualStyle: 'hidden_line',
      viewRange: { ...DEFAULT_VIEW_RANGE },
      line: { start: [-2.0, 15.0], end: [35.0, 15.0] },
    },
    {
      id: 'view-elev-s',
      name: 'Elevation: South',
      type: 'elevation',
      scale: '1/4" = 1\'-0"',
      detailLevel: 'medium',
      visualStyle: 'hidden_line',
      viewRange: { ...DEFAULT_VIEW_RANGE },
    },
    {
      id: 'view-elev-n',
      name: 'Elevation: North',
      type: 'elevation',
      scale: '1/4" = 1\'-0"',
      detailLevel: 'medium',
      visualStyle: 'hidden_line',
      viewRange: { ...DEFAULT_VIEW_RANGE },
    },
    {
      id: 'view-elev-e',
      name: 'Elevation: East',
      type: 'elevation',
      scale: '1/4" = 1\'-0"',
      detailLevel: 'medium',
      visualStyle: 'hidden_line',
      viewRange: { ...DEFAULT_VIEW_RANGE },
    },
    {
      id: 'view-elev-w',
      name: 'Elevation: West',
      type: 'elevation',
      scale: '1/4" = 1\'-0"',
      detailLevel: 'medium',
      visualStyle: 'hidden_line',
      viewRange: { ...DEFAULT_VIEW_RANGE },
    },
    {
      id: 'view-drafting-parapet',
      name: 'Drafting: Parapet Detail',
      type: 'drafting',
      scale: '1" = 1\'-0"',
      scaleDenominator: 12,
      detailLevel: 'fine',
      visualStyle: 'hidden_line',
      viewRange: { ...DEFAULT_VIEW_RANGE },
    },
  ],
  activeViewId: 'view-3d',
  viewLayout: 'split-2v',

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
  draftingLayers: DEFAULT_DRAFTING_LAYERS,
  layerGroups: DEFAULT_LAYER_GROUPS,
  textStyles: DEFAULT_TEXT_STYLES,
  dimensionStyles: DEFAULT_DIMENSION_STYLES,
  activeAnnotationTool: 'select',
  activeLayerId: 'layer-anno-note',
  activeTextStyleId: 'style-text-standard',
  activeDimensionStyleId: 'style-dim-arch-tick',
  selectedAnnotationId: null,
  draftEntities: DEFAULT_DRAFT_ENTITIES,

  rev: undefined,
  docId: undefined,
  elements: {},
  types: [],
  meshes: [],
  grids: [],
  sliced2D: null,

  // 1D/2D Parametric Constraints
  constraints: [],
  alignPickState: { step: null, refGuid: null },
  trimPickState: { step: null, firstGuid: null, firstPoint: null },

  selectedGuid: null,
  selectedGuids: [],
  hoveredGuid: null,
  hoverCandidates: [],
  snapsEnabled: true,
  planeLock: null,
  setPlaneLock: (lock) => set({ planeLock: lock }),

  wallHeight: 10.0,
  wallLocationLine: 'centerline',
  wallOffset: 0.0,
  wallLevelId: null,

  sectionBox: {
    enabled: false,
    min: [-2, -2, -0.5],
    max: [14, 11, 4.0],
  },
  hiddenGuids: [],
  isolatedGuids: [],
  tempDimension: null,

  // UI-P0-7: UNSET, and it means it. These were a real NAD83 / Washington North
  // survey position (~1,275,432 E, 234,568 N), so the Georeferencing dialog opened
  // pre-filled with coordinates belonging to nobody and a save could write them
  // into the file's IfcMapConversion. An empty `projected_crs` is the "not set"
  // state; the backend writes no georeferencing until the user chooses one.
  georeference: {
    projected_crs: '',
    eastings: 0.0,
    northings: 0.0,
    elevation: 0.0,
    true_north: 0.0,
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
  cameraProjection: 'perspective',

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

  // Unified Interaction Session (Track B Phase 1)
  interactionSession: createInitialSession('select'),
  activeDragSessionId: null,
  lastGestureCommit: null,
  setLastGestureCommit: (commit) => set({ lastGestureCommit: commit }),
  dispatchInteraction: (action: InteractionAction) =>
    set((state) => ({
      interactionSession: interactionReducer(state.interactionSession, action),
    })),

  // Actions
  setActiveRibbonTab: (tab) => set({ activeRibbonTab: tab }),
  setActiveTool: (tool, ribbonTab) => {
    const previous = get().activeTool;
    const base = ribbonTab ? { activeRibbonTab: ribbonTab } : {};
    get().dispatchInteraction({ type: 'begin', tool });
    if (tool === 'AL') {
      set({ ...base, activeTool: 'AL', alignPickState: { step: 'pick_ref', refGuid: null }, trimPickState: { step: null, firstGuid: null, firstPoint: null } });
    } else if (tool === 'TR') {
      set({ ...base, activeTool: 'TR', trimPickState: { step: 'pick_second', firstGuid: null, firstPoint: null }, alignPickState: { step: null, refGuid: null } });
    } else {
      set({ ...base, activeTool: tool, alignPickState: { step: null, refGuid: null }, trimPickState: { step: null, firstGuid: null, firstPoint: null } });
    }
    // UI-P0-11: switching tools discards any half-finished pick from the previous
    // tool. Without this, `boxStartPoint` was shared by Roof and Floor, so clicking
    // "Slab" after starting a roof silently reused the roof's first corner.
    if (previous !== tool) get().resetInteraction('tool-change');
  },

  resetInteraction: (reason) => {
    if (get().activeDragSessionId) {
      get().endDrag(false);
    }
    get().dispatchInteraction({ type: 'cancel' });
    set((state) => ({
      interactionResetToken: state.interactionResetToken + 1,
      interactionResetReason: reason,
      planeLock: null,
    }));
  },

  // Revit Two-Letter Non-Modifier Hotkey Engine (1000ms debounce)
  handleKeyStroke: (key) => {
    const state = get();
    const upperKey = key.toUpperCase();

    // Arrow keys toggle direct modeling Plane Lock (IngeTrazo plane lock)
    if (key === 'ArrowUp') {
      const next = state.planeLock === 'z' ? null : 'z';
      set({ planeLock: next });
      get().setStatusMessage(next ? 'Plane locked: Z-Axis (XY Plane)' : 'Plane lock cleared');
      return;
    }
    if (key === 'ArrowRight') {
      const next = state.planeLock === 'x' ? null : 'x';
      set({ planeLock: next });
      get().setStatusMessage(next ? 'Plane locked: X-Axis (YZ Plane)' : 'Plane lock cleared');
      return;
    }
    if (key === 'ArrowLeft') {
      const next = state.planeLock === 'y' ? null : 'y';
      set({ planeLock: next });
      get().setStatusMessage(next ? 'Plane locked: Y-Axis (XZ Plane)' : 'Plane lock cleared');
      return;
    }
    if (key === 'ArrowDown') {
      const next = state.planeLock === 'ref' ? null : 'ref';
      set({ planeLock: next });
      get().setStatusMessage(next ? 'Plane locked: Reference Normal' : 'Plane lock cleared');
      return;
    }

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
      const isMidGesture =
        state.interactionSession.picks.length > 0 ||
        state.interactionSession.phase === 'picking' ||
        state.interactionSession.phase === 'dragging';
      if (isMidGesture && state.activeTool !== 'select') {
        get().resetInteraction('escape');
        return;
      }
      get().dispatchInteraction({ type: 'begin', tool: 'select' });
      set({
        activeTool: 'select',
        selectedGuid: null,
        selectedGuids: [],
        tempDimension: null,
        alignPickState: { step: null, refGuid: null },
        trimPickState: { step: null, firstGuid: null, firstPoint: null },
        planeLock: null,
      });
      // UI-P0-10: this is the *only* Escape path now. It must also discard
      // in-progress viewport state (a first wall point, a first box corner, a
      // pending sketch point, an open dimension editor), which previously survived
      // the cancel and let the next click complete geometry from a stale point.
      get().resetInteraction('escape');
      return;
    }

    // Enter commits active sketch mode
    if (key === 'Enter' && state.sketchSession) {
      get().finishSketchMode();
      return;
    }

    // Hotkey lookup table.
    //
    // UI-P0-14: only tools that a viewport actually implements are bound here.
    // GR/LL/DI/DL/TG/TX/SEC/SHT used to be listed, but they only set `activeTool`
    // to a value neither viewport consumes — the tool armed, the cursor turned into
    // a crosshair, and the status bar said "Click in viewport to place" while
    // nothing could happen. They come back with the command registry (UI-P2) and
    // the Options Bar (UI-P3). EQ has a real bus command today, so its key keeps
    // working and now matches what the ribbon button does.
    const hotkeys: Record<string, () => void> = {
      WA: () => get().setActiveTool('WA', 'Architecture'),
      DR: () => get().setActiveTool('DR', 'Architecture'),
      WN: () => get().setActiveTool('WN', 'Architecture'),
      SB: () => get().startSketchMode('floor'),
      RF: () => get().startSketchMode('roof'),
      LI: () => {
        if (get().sketchSession) get().setSketchDrawTool('line');
        else get().setActiveTool('LI', 'Model');
      },
      RE: () => {
        if (get().sketchSession) get().setSketchDrawTool('rectangle');
        else get().setActiveTool('REC', 'Model');
      },
      REC: () => get().setActiveTool('REC', 'Model'),
      CI: () => get().setActiveTool('CI', 'Model'),
      AR: () => get().setActiveTool('AR', 'Model'),
      PP: () => get().setActiveTool('PP', 'Model'),
      OF: () => get().setActiveTool('OF', 'Model'),
      FM: () => get().setActiveTool('FM', 'Model'),
      TP: () => get().setActiveTool('TP', 'Model'),
      MV: () => get().setActiveTool('MV', 'Model'),
      RO: () => get().setActiveTool('RO', 'Model'),
      SC: () => get().setActiveTool('SC', 'Model'),
      GP: () => get().setActiveTool('GP', 'Model'),
      TW: () => {
        if (get().selectedGuid || get().selectedGuids.length > 0) {
          get().tagSelectedElement('IfcWall');
        } else {
          get().setViewLayout('tabs');
          window.dispatchEvent(new CustomEvent(TAB_VIEWS_EVENT));
        }
      },
      TF: () => get().tagSelectedElement('IfcSlab'),
      TC: () => get().tagSelectedElement('IfcColumn'),
      PW: () => {
        if (get().sketchSession) get().setSketchDrawTool('pick_walls');
      },
      BX: () => get().toggleSectionBox(),
      AL: () =>
        // Routed through setActiveTool so the previous tool's in-progress pick is
        // discarded (UI-P0-11) — the raw `set` this used to do skipped that.
        get().setActiveTool('AL'),
      TR: () => {
        if (get().activeRibbonTab === 'Model') get().tagSelectedElement('IfcRoof');
        else get().setActiveTool('TR', 'Modify');
      },
      SL: () => get().setActiveTool('SL', 'Modify'),
      SO: () => get().setActiveTool('SO', 'Modify'),
      EQ: () => get().equalizeSouthWallWindows(),
      HH: () => get().tempHideSelected(),
      HR: () => get().resetTempVisibility(),
      HI: () => get().tempIsolateSelected(),
      ZE: () => {
        window.dispatchEvent(new CustomEvent(ZOOM_EXTENTS_EVENT));
      },
      ZA: () => {
        window.dispatchEvent(new CustomEvent(ZOOM_EXTENTS_EVENT));
      },
      CS: () => {
        get().createSimilar();
      },
      WT: () => {
        get().cycleViewLayout();
        window.dispatchEvent(new CustomEvent(TILE_WINDOWS_EVENT));
      },
      EL: () => {
        get().setActiveTool('EL');
        const el = get().views.find((v) => v.type === 'elevation');
        if (el) get().setActiveViewId(el.id);
      },
      MD: () => {
        get().setActiveTool('select');
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
    // view engine and were previously never requested. Drafting views are pure 2D and do not fetch slices.
    if (view && view.type !== '3d' && view.type !== 'sheet' && view.type !== 'drafting') {
      const cut = view.viewRange?.cut ?? (view as any)?.view_range?.cut ?? 4.0;
      get().fetch2DSlice(cut);
    } else if (view && view.type === '3d' && view.projection) {
      set({ cameraProjection: view.projection });
    }
  },

  addView: (view) => set((s) => ({ views: [...s.views, view] })),

  setActiveSheetId: (id) => set({ activeSheetId: id }),

  setViewLayout: (layout) => set({ viewLayout: layout }),

  cycleViewLayout: () => {
    const layouts: Array<'split-2v' | 'split-2h' | 'quad' | 'single-3d' | 'tabs'> = [
      'split-2v',
      'quad',
      'split-2h',
      'single-3d',
      'tabs',
    ];
    const current = get().viewLayout;
    const currentIndex = layouts.indexOf(current as any);
    const nextIndex = (currentIndex + 1) % layouts.length;
    set({ viewLayout: layouts[nextIndex] });
  },

  setSelectedGuid: (guid) => {
    set({ selectedGuid: guid, selectedGuids: guid ? [guid] : [] });
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
      // Phase 2: For walls, measure their baseline length directly so selecting a wall
      // displays its actual length (and editing resizes it, rather than moving it).
      if (mesh.params?.start && mesh.params?.end) {
        const sp = mesh.params.start;
        const ep = mesh.params.end;
        const wallLen = Math.hypot(ep[0] - sp[0], ep[1] - sp[1]);
        if (wallLen > 0.05) {
          set({
            tempDimension: {
              elementGuid: guid,
              distance: wallLen,
              displayValue: formatLength(wallLen, get().displayUnit),
              witnessP1: sp,
              witnessP2: ep,
              center: [
                (sp[0] + ep[0]) / 2,
                (sp[1] + ep[1]) / 2,
                ((sp[2] ?? 0) + (ep[2] ?? 0)) / 2,
              ],
              axis: 'x',
              kind: 'length',
            } as any,
          });
          return;
        }
      }

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

      // UI-P0-2: `nearestDist` is ALREADY decimal feet — the internal unit — so
      // multiplying by 3.28084 here (as this did) rendered every temporary
      // dimension 3.28x too large and then labelled the inflated number with a foot
      // mark. `formatLength` honours the user's display unit, exactly as the
      // Properties palette already does.
      const display = formatLength(nearestDist, get().displayUnit);

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

  setSelectedGuids: (guids) => {
    const primary = guids.length > 0 ? guids[guids.length - 1] : null;
    get().setSelectedGuid(primary);
    set({ selectedGuids: guids });
  },

  setHoverCandidates: (guids) => set({ hoverCandidates: guids }),

  cycleTabSelection: () => {
    const { hoverCandidates, hoveredGuid, elements, setHoveredGuid, setStatusMessage } = get();
    if (!hoverCandidates || hoverCandidates.length === 0) return;
    const currentIdx = hoveredGuid ? hoverCandidates.indexOf(hoveredGuid) : -1;
    const nextIdx = (currentIdx + 1) % hoverCandidates.length;
    const nextGuid = hoverCandidates[nextIdx];
    setHoveredGuid(nextGuid);
    const el = elements[nextGuid];
    if (el) {
      setStatusMessage(`${el.name || el.ifc_class} (${nextIdx + 1}/${hoverCandidates.length} - Tab to cycle)`);
    }
  },

  toggleSnaps: () => {
    const next = !get().snapsEnabled;
    set({ snapsEnabled: next });
    get().setStatusMessage(`Snaps ${next ? 'enabled' : 'disabled (F3)'}`);
  },

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
    const { tempDimension, translateElement, setDimensionValue } = get();
    if (!tempDimension) return;

    // Phase 2.5: If dimension measures element length, resize the element's baseline
    if ((tempDimension as any).kind === 'length') {
      await setDimensionValue(tempDimension.elementGuid, newValue, 'start');
      get().setSelectedGuid(tempDimension.elementGuid);
      return;
    }

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
  setCameraProjection: (mode) => set({ cameraProjection: mode }),
  toggleCameraProjection: () =>
    set((state) => ({
      cameraProjection: state.cameraProjection === 'perspective' ? 'isometric' : 'perspective',
    })),

  setGeoreferenceModalOpen: (open) => set({ isGeoreferenceModalOpen: open }),
  setEditTypeModalOpen: (open) => set({ isEditTypeModalOpen: open }),
  setViewRangeModalOpen: (open) => set({ isViewRangeModalOpen: open }),

  setViewLevel: (viewId, levelId) => {
    set((state) => ({
      views: state.views.map((v) => (v.id === viewId ? { ...v, levelId } : v)),
    }));
    // Refetch so the drawing follows the selection immediately.
    const active = get().activeViewId;
    if (active === viewId) get().fetch2DSlice();
  },

  setViewCut: (viewId, cutAboveLevel) => {
    set((state) => ({
      views: state.views.map((v) =>
        v.id === viewId
          ? {
              ...v,
              viewRange: {
                ...(v.viewRange ?? (v as any)?.view_range ?? DEFAULT_VIEW_RANGE),
                cut: cutAboveLevel,
              },
            }
          : v
      ),
    }));
    const active = get().activeViewId;
    if (active === viewId) get().fetch2DSlice(cutAboveLevel);
  },
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
      set({ statusMessage: `Create align constraint failed: ${failureMessage(e)}` });
      console.error('Failed to create align constraint', e);
    }
  },

  setTrimPickState: (state) => set({ trimPickState: state }),

  trimExtendWall: async (guid, endIndex, targetGuid, cornerMode = true, targetEndIndex) => {
    try {
      await get().dispatchTransaction(
        'trimExtendWall',
        {
          guid,
          end_index: endIndex,
          target_guid: targetGuid,
          corner_mode: cornerMode,
          target_end_index: targetEndIndex,
        },
        cornerMode ? 'Trim / extend to corner' : 'Trim / extend wall'
      );
      set({ trimPickState: { step: null, firstGuid: null, firstPoint: null } });
      if (!get().chainTools) {
        set({ activeTool: 'select' });
      }
    } catch (e) {
      set({ statusMessage: `Trim/Extend failed: ${failureMessage(e)}` });
      console.error('Failed to trim/extend wall', e);
    }
  },

  splitWall: async (guid, atOffset, gap = 0.0) => {
    try {
      await get().dispatchTransaction(
        'splitWall',
        { guid, at_offset: atOffset, gap },
        gap > 0 ? 'Split wall with gap' : 'Split wall'
      );
      if (!get().chainTools) {
        set({ activeTool: 'select' });
      }
    } catch (e) {
      set({ statusMessage: `Split wall failed: ${failureMessage(e)}` });
      console.error('Failed to split wall', e);
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
      set({ statusMessage: `Toggle constraint lock failed: ${failureMessage(e)}` });
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
      set({ statusMessage: `Lock dimension failed: ${failureMessage(e)}` });
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
      set({ statusMessage: `Equalize span failed: ${failureMessage(e)}` });
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
      set({ statusMessage: `Delete constraint failed: ${failureMessage(e)}` });
      console.error('Failed to delete constraint', e);
    }
  },

  setDimensionValue: async (dimensionId: string, value: number, anchor: 'start' | 'end' | 'center' = 'start') => {
    try {
      await get().dispatchTransaction(
        'setDimensionValue',
        {
          dimension_id: dimensionId,
          value,
          anchor,
        },
        `Set dimension to ${value} ft`
      );
    } catch (e) {
      set({ statusMessage: `Set dimension failed: ${failureMessage(e)}` });
      console.error('Failed to set dimension value', e);
      throw e;
    }
  },

  createDimension: async (params) => {
    try {
      await get().dispatchTransaction(
        'createDimension',
        params,
        'Create dimension'
      );
    } catch (e) {
      set({ statusMessage: `Create dimension failed: ${failureMessage(e)}` });
      console.error('Failed to create dimension', e);
      throw e;
    }
  },

  deleteDimension: async (dimensionId: string) => {
    try {
      await get().dispatchTransaction(
        'deleteDimension',
        { dimension_id: dimensionId },
        'Delete dimension'
      );
    } catch (e) {
      set({ statusMessage: `Delete dimension failed: ${failureMessage(e)}` });
      console.error('Failed to delete dimension', e);
      throw e;
    }
  },

  toggleDimensionLock: async (dimensionId: string, isLocked: boolean) => {
    try {
      await get().dispatchTransaction(
        'toggleDimensionLock',
        { dimension_id: dimensionId, is_locked: isLocked },
        `${isLocked ? 'Lock' : 'Unlock'} dimension`
      );
    } catch (e) {
      set({ statusMessage: `Toggle dimension lock failed: ${failureMessage(e)}` });
      console.error('Failed to toggle dimension lock', e);
      throw e;
    }
  },

  undo: async () => {
    try {
      const res = await fetch('/api/transaction/undo', { method: 'POST' });
      if (res.ok) {
        await get().fetchStateBundle();
      }
    } catch (e) {
      console.error('Undo failed', e);
    }
  },

  redo: async () => {
    try {
      const res = await fetch('/api/transaction/redo', { method: 'POST' });
      if (res.ok) {
        await get().fetchStateBundle();
      }
    } catch (e) {
      console.error('Redo failed', e);
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

    // Phase 0.1: Ensure distinct span endpoints. If distinct boundary walls join
    // southWall at its endpoints, use them as span_start and span_end so the targets
    // equalize across the host wall's full span. Otherwise, if targets has at least 3
    // elements, equalize between the first and last target. If neither, find distinct walls
    // in the model to avoid a degenerate 0-length span (pos_start == pos_end).
    const sWall = elements[southWall];
    let startGuid: string | undefined;
    let endGuid: string | undefined;
    let interiorGuids = targets;

    if (sWall?.start && sWall?.end) {
      const otherWalls = meshes
        .filter((m) => WALL_CLASSES.includes(m.ifc_class) && m.guid !== southWall)
        .map((m) => m.guid);

      for (const og of otherWalls) {
        const oe = elements[og];
        if (!oe?.start || !oe?.end) continue;
        const dStart = Math.min(
          Math.hypot(oe.start[0] - sWall.start[0], oe.start[1] - sWall.start[1]),
          Math.hypot(oe.end[0] - sWall.start[0], oe.end[1] - sWall.start[1])
        );
        const dEnd = Math.min(
          Math.hypot(oe.start[0] - sWall.end[0], oe.start[1] - sWall.end[1]),
          Math.hypot(oe.end[0] - sWall.end[0], oe.end[1] - sWall.end[1])
        );
        if (dStart < 0.5 && !startGuid) startGuid = og;
        if (dEnd < 0.5 && !endGuid && og !== startGuid) endGuid = og;
      }

      if (!startGuid || !endGuid) {
        for (const og of otherWalls) {
          if (!startGuid && og !== endGuid) startGuid = og;
          else if (!endGuid && og !== startGuid) endGuid = og;
        }
      }
    }

    if (!startGuid || !endGuid || startGuid === endGuid) {
      if (targets.length >= 3) {
        const sorted = [...targets].sort((a, b) => {
          const ax = elements[a]?.offset_along_wall ?? elements[a]?.start?.[0] ?? 0;
          const bx = elements[b]?.offset_along_wall ?? elements[b]?.start?.[0] ?? 0;
          return ax - bx;
        });
        startGuid = sorted[0];
        endGuid = sorted[sorted.length - 1];
        interiorGuids = sorted.slice(1, -1);
      } else {
        set({ statusMessage: 'Cannot equalize: South wall requires at least 3 elements to distribute' });
        return;
      }
    }

    await get().equalizeSpan(startGuid, endGuid, interiorGuids, 'x');
  },

  // API Callbacks
  fetchStateBundle: async (cutElevation?: number) => {
    const ctx = sliceContext(get().views, get().activeViewId, cutElevation);
    const q = new URLSearchParams({ cut_elevation: String(ctx.cut) });
    if (ctx.levelId) q.set('level_id', String(ctx.levelId));
    if (ctx.viewType !== 'floor_plan') {
      q.set('view_type', ctx.viewType);
      if (ctx.top !== undefined) q.set('top', String(ctx.top));
      if (ctx.bottom !== undefined) q.set('bottom', String(ctx.bottom));
      // A view depth of 0 means "not set"; sending it would filter everything out.
      if (ctx.viewDepth) q.set('view_depth', String(ctx.viewDepth));
    }
    const curRev = get().rev;
    const curDocId = get().docId;
    if (curRev !== undefined) {
      q.set('since', String(curRev));
    }
    if (curDocId !== undefined) {
      q.set('doc_id', curDocId);
    }

    if (bundleUnsupported) {
      await refreshIndividually(get, cutElevation);
      return;
    }

    const t0 = performance.now();
    try {
      const res = await fetch(`${API_BASE}/state?${q.toString()}`);
      if (res.status === 404) {
        // The engine predates /api/state. Trip once rather than paying a failed
        // request on every commit; the fallback keeps the app correct.
        bundleUnsupported = true;
        console.warn(
          'Engine has no /api/state (404) - using the per-resource refresh path.'
        );
        // The breaker state changed even though no refresh sample was recorded,
        // so refresh the exposed diagnostics rather than leaving them stale.
        (globalThis as any).__bimworksRefresh = refreshStats();
        await refreshIndividually(get, cutElevation);
        return;
      }
      if (!res.ok) throw new Error(`state bundle HTTP ${res.status}`);
      const data = await res.json();

      // Two numbers, recorded separately and never reported as one another.
      recordRefresh(performance.now() - t0, data.engine_ms);

      // Response A - unchanged
      if (data.unchanged) {
        if (data.doc_id && get().docId !== data.doc_id) {
          set({ docId: data.doc_id });
        }
        return;
      }

      const cur = get();

      // Response B - delta
      if (Array.isArray(data.upsert_meshes) || Array.isArray(data.remove_guids)) {
        // If delta is based on wrong epoch or wrong base rev, trigger a full resync
        if (
          (cur.docId && data.doc_id && cur.docId !== data.doc_id) ||
          (data.base_rev !== undefined && cur.rev !== undefined && data.base_rev !== cur.rev)
        ) {
          console.warn('Delta epoch or base revision mismatch; triggering full state resync');
          set({ rev: undefined, docId: undefined });
          await get().fetchStateBundle(cutElevation);
          return;
        }

        const removeSet = new Set<string>(data.remove_guids || []);
        const upsertMap = new Map<string, MeshBufferData>();
        for (const m of (data.upsert_meshes || []) as MeshBufferData[]) {
          upsertMap.set(m.guid, m);
        }

        const updatedMeshes: MeshBufferData[] = [];
        for (const m of cur.meshes) {
          if (removeSet.has(m.guid)) continue;
          if (upsertMap.has(m.guid)) {
            updatedMeshes.push(upsertMap.get(m.guid)!);
            upsertMap.delete(m.guid);
          } else {
            updatedMeshes.push(m);
          }
        }
        for (const newMesh of upsertMap.values()) {
          updatedMeshes.push(newMesh);
        }

        const updatedElements = { ...cur.elements };
        for (const guid of removeSet) {
          delete updatedElements[guid];
        }
        for (const mesh of (data.upsert_meshes || []) as MeshBufferData[]) {
          const params = mesh.params;
          if (!params) continue;
          updatedElements[mesh.guid] = {
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
            type_id: params.type_id,
          };
        }

        let updatedJournal = cur.transactionJournal;
        if (data.journal_append && data.journal_append.length > 0) {
          const existingIds = new Set(cur.transactionJournal.map((j) => j.transaction_id));
          const newEntries = (data.journal_append as TransactionJournalEntry[]).filter(
            (j) => !existingIds.has(j.transaction_id)
          );
          updatedJournal = [...cur.transactionJournal, ...newEntries];
        }
        if (updatedJournal.length > 50) {
          updatedJournal = updatedJournal.slice(updatedJournal.length - 50);
        }

        set({
          docId: data.doc_id ?? cur.docId,
          rev: data.rev ?? cur.rev,
          meshes: updatedMeshes,
          elements: updatedElements,
          ...(data.slice2d ? { sliced2D: data.slice2d } : {}),
          transactionJournal: updatedJournal,
          ...(cur.selectedGuid && removeSet.has(cur.selectedGuid) ? { selectedGuid: null } : {}),
          ...(data.levels ? { levels: data.levels } : {}),
          ...(data.grids ? { grids: data.grids } : {}),
          ...(data.sheets ? { sheets: data.sheets } : {}),
          ...(data.views ? { views: (data.views as any[]).map(normalizeView) } : {}),
          ...(data.types ? { types: data.types } : {}),
          ...(data.constraints ? { constraints: data.constraints } : {}),
          ...(data.wall_joins ? { wallJoins: data.wall_joins } : {}),
          ...(data.project
            ? {
                projectName: data.project.project_name || cur.projectName,
                georeference: data.project.georeference || cur.georeference,
              }
            : {}),
        });
        return;
      }

      // Response C - full bundle
      set({
        docId: data.doc_id ?? cur.docId,
        rev: data.rev ?? cur.rev,
        ...(data.project
          ? {
              projectName: data.project.project_name || cur.projectName,
              georeference: data.project.georeference || cur.georeference,
            }
          : {}),
        ...(data.constraints ? { constraints: data.constraints } : {}),
        ...(data.wall_joins ? { wallJoins: data.wall_joins } : {}),
        ...(data.geometry ? geometryPatch(data.geometry, cur) : {}),
        // A failed slice returns null; keep the last good linework rather than
        // blanking the viewport.
        ...(data.slice2d ? { sliced2D: data.slice2d } : {}),
        ...(data.journal ? { transactionJournal: data.journal.slice(-50) } : {}),
        ...(data.sheets ? { sheets: data.sheets } : {}),
        ...(data.views ? { views: (data.views as any[]).map(normalizeView) } : {}),
        ...(data.types ? { types: data.types } : {}),
      });

      if (data.errors) {
        for (const [section, message] of Object.entries(data.errors)) {
          const key = `${section}: ${message}`;
          if (reportedSectionErrors.has(key)) continue;
          reportedSectionErrors.add(key);
          console.warn(`State bundle section "${section}" failed: ${message}`);
        }
      }
    } catch (e) {
      console.error('State bundle refresh failed; falling back to per-resource fetches', e);
      await refreshIndividually(get, cutElevation);
    }
  },

  fetchProjectState: async () => {
    try {
      // Constraints are NOT fetched here. This used to call fetchConstraints(),
      // and every caller then called fetchConstraints() again - two requests for
      // one resource per refresh. Callers that need them ask for them.
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
            type_id: params.type_id,
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
      const range = active?.viewRange ?? (active as any)?.view_range;
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
        // Plans are LEVEL-RELATIVE: `cut` is a height above the storey, not an absolute
        // elevation, which is the Revit convention and the only thing that works on a
        // real model (a storey at 1824 ft cut at an absolute 4 ft sections empty space).
        // The active view's level is the storey it draws.
        const levelId = active?.levelId ?? (active as any)?.level_id;
        const q = new URLSearchParams({ cut_elevation: String(cut) });
        if (levelId) q.set('level_id', levelId);
        url = `${API_BASE}/slice/2d?${q.toString()}`;
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
        const data = await res.json().catch(() => ({}));
        set({ rev: undefined, docId: undefined });
        await get().fetchStateBundle();
        setTimeout(() => window.dispatchEvent(new CustomEvent(ZOOM_EXTENTS_EVENT)), 150);
        // Counts come from the response. The old 13/3 literals described a sample the
        // loader no longer uses, so the status bar reported numbers for a model that
        // was not on screen.
        const elemCount = typeof data?.elements_count === 'number' ? data.elements_count : null;
        const levelCount = typeof data?.levels_count === 'number' ? data.levels_count : null;
        set({
          projectName: data?.project_name || 'BIMWorks Prototype Building',
          isLoadingFile: false,
          statusMessage: elemCount !== null && levelCount !== null
            ? `Sample BIM Project Loaded (${elemCount} elements, ${levelCount} levels)`
            : 'Sample BIM Project Loaded',
        });
      }
    } catch (e) {
      set({ statusMessage: `Load sample building failed: ${failureMessage(e)}` });
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
          rev: undefined,
          docId: undefined,
        });
        await get().fetchStateBundle();
        // A loaded model is rarely near the origin — a real Revit export carries shared
        // coordinates (the shipped ADU sits at x −25…−11 ft, z 558…567 ft) — while the
        // camera is still framed on whatever was open before. The load reported success
        // and the viewport showed empty space. Fit the view to the new geometry.
        // Deferred a frame so the viewports have mounted their listeners with the new
        // document before the event fires.
        setTimeout(() => window.dispatchEvent(new CustomEvent(ZOOM_EXTENTS_EVENT)), 150);
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
      set({ statusMessage: `Load IFC content failed: ${failureMessage(e)}` });
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

  /**
   * UI-P0-1: what happens after one placement completes.
   *
   * Revit leaves the tool armed, so the next click starts the next element. The
   * original code unconditionally ran `set({ activeTool: 'select' })` here, which
   * is why drawing a four-wall room needed four separate ribbon clicks — and why
   * the project's own "corner chain of 8 walls" acceptance criterion had no UI
   * path to exercise it.
   *
   * With chaining on (the default) the tool stays armed and only the viewport's
   * own in-progress points are cleared, which the viewport does as part of
   * completing the element. With chaining off we reproduce the old single-shot
   * behaviour, including the reset that discards the completed interaction's state.
   */
  completePlacement: () => {
    get().dispatchInteraction({ type: 'commit' });
    if (get().chainTools) return;
    set({ activeTool: 'select' });
    get().resetInteraction('tool-change');
  },

  handleDeleteKey: () => {
    const state = get();
    // While a sketch is open, Delete belongs to the sketch. The store used to have
    // no Delete handling at all, so `App.tsx` fell straight through to
    // `deleteElement(selectedGuid)` — and because `startSketchMode` deliberately
    // leaves the host element selected (the sketch seeds its boundary from that
    // element), pressing Delete while editing a floor DELETED THE FLOOR. The
    // viewport's own `deleteSelectedSketchLine` was destructured and never called,
    // so there was also no way to remove a sketch line at all.
    if (state.sketchSession) {
      if (state.sketchSession.selectedLineId) {
        get().deleteSelectedSketchLine();
        return;
      }
      set((s) => ({
        sketchSession: s.sketchSession
          ? { ...s.sketchSession, validationError: 'Select a boundary line to delete it.' }
          : null,
      }));
      return;
    }
    if (state.selectedGuids && state.selectedGuids.length > 0) {
      for (const g of state.selectedGuids) {
        get().deleteElement(g);
      }
      set({ selectedGuids: [], selectedGuid: null });
    } else if (state.selectedGuid) {
      get().deleteElement(state.selectedGuid);
    }
  },

  createWall: async (start, end, name = 'Basic Wall : Exterior - 10" CMU') => {
    try {
      const state = get();
      await get().dispatchTransaction(
        'createWall',
        {
          start,
          end,
          height: state.wallHeight || 10.0,
          thickness: 0.8333,
          name,
          level_id: state.wallLevelId || undefined,
        },
        `Create wall "${name}"`
      );
      get().completePlacement();
    } catch (e) {
      set({ statusMessage: `Create wall failed: ${failureMessage(e)}` });
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
      get().completePlacement();
    } catch (e) {
      set({ statusMessage: `Insert door failed: ${failureMessage(e)}` });
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
      get().completePlacement();
    } catch (e) {
      set({ statusMessage: `Insert window failed: ${failureMessage(e)}` });
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
      get().completePlacement();
    } catch (e) {
      set({ statusMessage: `Create roof failed: ${failureMessage(e)}` });
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
      get().completePlacement();
    } catch (e) {
      set({ statusMessage: `Create slab failed: ${failureMessage(e)}` });
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
      set({ statusMessage: `Update element failed: ${failureMessage(e)}` });
      console.error('Failed to update element', e);
    }
  },

  tagSelectedElement: async (targetClass: 'IfcWall' | 'IfcSlab' | 'IfcColumn' | 'IfcRoof') => {
    const { selectedGuid, selectedGuids, elements, meshes, updateElement, setStatusMessage } = get();
    const guidsToTag = selectedGuids.length > 0 ? selectedGuids : (selectedGuid ? [selectedGuid] : []);
    if (guidsToTag.length === 0) {
      setStatusMessage(`Select an element or solid first to tag as ${targetClass}.`);
      return;
    }
    for (const guid of guidsToTag) {
      const el = elements[guid];
      const mesh = meshes.find((m) => m.guid === guid);
      const volume = mesh ? calculateMeshVolume(mesh.vertices, mesh.indices) : el?.volume;
      const area = mesh ? calculateMeshArea(mesh.vertices, mesh.indices) : el?.area;
      await updateElement(guid, {
        ifc_class: targetClass,
        name: `${targetClass.replace('Ifc', '')} : Custom Model Solid`,
        ...(volume !== undefined ? { volume } : {}),
        ...(area !== undefined ? { area } : {}),
      });
    }
    setStatusMessage(`Tagged ${guidsToTag.length} element(s) as ${targetClass}.`);
  },

  addModelMesh: (mesh: MeshBufferData, element?: Partial<BimElement>) => {
    const elem: BimElement = {
      guid: mesh.guid,
      ifc_class: (mesh.ifc_class || 'IfcBuildingElementProxy') as any,
      name: mesh.name,
      start: mesh.params?.start,
      end: mesh.params?.end,
      length: mesh.params?.length,
      height: mesh.params?.height,
      thickness: mesh.params?.thickness,
      volume: mesh.params?.volume,
      area: mesh.params?.area,
      polygon: mesh.params?.polygon,
      ...element,
    };
    set((state) => ({
      meshes: [...state.meshes.filter((m) => m.guid !== mesh.guid), mesh],
      elements: { ...state.elements, [mesh.guid]: elem },
      selectedGuid: mesh.guid,
      statusMessage: `Created ${mesh.name}`,
    }));
  },

  updateModelMesh: (guid: string, updates: Partial<MeshBufferData>) => {
    set((state) => {
      const existingMesh = state.meshes.find((m) => m.guid === guid);
      if (!existingMesh) return state;
      const updatedMesh: MeshBufferData = {
        ...existingMesh,
        ...updates,
        params: {
          ...existingMesh.params,
          ...updates.params,
        },
      };
      const existingElem = state.elements[guid];
      const updatedElem: BimElement = existingElem
        ? {
            ...existingElem,
            name: updatedMesh.name || existingElem.name,
            volume: updatedMesh.params?.volume ?? existingElem.volume,
            area: updatedMesh.params?.area ?? existingElem.area,
            height: updatedMesh.params?.height ?? existingElem.height,
          }
        : {
            guid,
            ifc_class: (updatedMesh.ifc_class || 'IfcBuildingElementProxy') as any,
            name: updatedMesh.name,
            volume: updatedMesh.params?.volume,
            area: updatedMesh.params?.area,
          };
      return {
        meshes: state.meshes.map((m) => (m.guid === guid ? updatedMesh : m)),
        elements: { ...state.elements, [guid]: updatedElem },
        statusMessage: `Updated ${updatedMesh.name}`,
      };
    });
  },

  deleteElement: async (guid) => {
    try {
      await get().dispatchTransaction('deleteElement', { guid }, 'Delete element');
      set({ selectedGuid: null, tempDimension: null });
    } catch (e) {
      set((state) => {
        const nextElements = { ...state.elements };
        delete nextElements[guid];
        return {
          meshes: state.meshes.filter((m) => m.guid !== guid),
          elements: nextElements,
          selectedGuid: null,
          tempDimension: null,
        };
      });
      set({ statusMessage: `Delete element failed: ${failureMessage(e)}` });
      console.error('Failed to delete element', e);
    }
  },

  translateElement: async (guid, dx, dy, dz = 0.0) => {
    try {
      await get().dispatchTransaction('translateElement', { guid, dx, dy, dz }, 'Move element');
    } catch (e) {
      set({ statusMessage: `Translate element failed: ${failureMessage(e)}` });
      console.error('Failed to translate element', e);
    }
  },

  moveReference: async (source, target, axis = 'aligned') => {
    try {
      await get().dispatchTransaction('moveReference', { source, target, axis }, 'Move reference');
    } catch (e) {
      set({ statusMessage: `Move reference failed: ${failureMessage(e)}` });
      console.error('Failed to move reference', e);
    }
  },

  modifyWallHeight: async (guid: string, height: number) => {
    try {
      await get().dispatchTransaction('modifyWallHeight', { guid, height }, 'Modify wall height');
    } catch (e) {
      set({ statusMessage: `Modify wall height failed: ${failureMessage(e)}` });
      console.error('Failed to modify wall height', e);
    }
  },

  modifyWallThickness: async (guid: string, thickness: number) => {
    try {
      await get().dispatchTransaction('modifyWallThickness', { guid, thickness }, 'Modify wall thickness');
    } catch (e) {
      set({ statusMessage: `Modify wall thickness failed: ${failureMessage(e)}` });
      console.error('Failed to modify wall thickness', e);
    }
  },

  modifyWallEnd: async (guid: string, end: 'start' | 'end', point: [number, number] | [number, number, number], clamp?: boolean) => {
    try {
      await get().dispatchTransaction('modifyWallEnd', { guid, end, point, ...(clamp !== undefined ? { clamp } : {}) }, 'Modify wall endpoint');
    } catch (e) {
      set({ statusMessage: `Modify wall end failed: ${failureMessage(e)}` });
      console.error('Failed to modify wall end', e);
    }
  },

  modifyOpeningOffset: async (guid: string, offset: number, clamp?: boolean) => {
    try {
      await get().dispatchTransaction('modifyOpeningOffset', { guid, offset, ...(clamp !== undefined ? { clamp } : {}) }, 'Modify opening offset');
    } catch (e) {
      set({ statusMessage: `Modify opening offset failed: ${failureMessage(e)}` });
      console.error('Failed to modify opening offset', e);
    }
  },

  modifyOpeningWidth: async (guid: string, width: number) => {
    try {
      await get().dispatchTransaction('modifyOpeningWidth', { guid, width }, 'Modify opening width');
    } catch (e) {
      set({ statusMessage: `Modify opening width failed: ${failureMessage(e)}` });
      console.error('Failed to modify opening width', e);
    }
  },

  modifyOpeningSillHeight: async (guid: string, sillHeight: number) => {
    try {
      await get().dispatchTransaction('modifyOpeningSillHeight', { guid, sill_height: sillHeight }, 'Modify opening sill height');
    } catch (e) {
      set({ statusMessage: `Modify opening sill height failed: ${failureMessage(e)}` });
      console.error('Failed to modify opening sill height', e);
    }
  },

  flipOpening: async (guid: string) => {
    try {
      await get().dispatchTransaction('flipOpening', { guid }, 'Flip opening');
    } catch (e) {
      set({ statusMessage: `Flip opening failed: ${failureMessage(e)}` });
      console.error('Failed to flip opening', e);
    }
  },

  modifyGridEndpoint: async (guid: string, end: 'start' | 'end', point: [number, number]) => {
    try {
      await get().dispatchTransaction('modifyGridEndpoint', { guid, end, point }, 'Modify grid endpoint');
    } catch (e) {
      set({ statusMessage: `Modify grid endpoint failed: ${failureMessage(e)}` });
      console.error('Failed to modify grid endpoint', e);
    }
  },

  modifyPolygonVertex: async (guid: string, vertexIndex: number, point: [number, number]) => {
    try {
      await get().dispatchTransaction('modifyPolygonVertex', { guid, vertex_index: vertexIndex, point }, 'Modify polygon vertex');
    } catch (e) {
      set({ statusMessage: `Modify polygon vertex failed: ${failureMessage(e)}` });
      console.error('Failed to modify polygon vertex', e);
    }
  },

  setWallHeight: (height) => set({ wallHeight: height }),
  setWallLocationLine: (loc) => set({ wallLocationLine: loc }),
  setWallOffset: (offset) => set({ wallOffset: offset }),
  setWallLevelId: (levelId) => set({ wallLevelId: levelId }),

  createSimilar: () => {
    const { selectedGuid, elements, meshes, setActiveTool, startSketchMode, setStatusMessage } = get();
    if (!selectedGuid) {
      setStatusMessage('Select an element to Create Similar (CS)');
      return;
    }
    const elem = elements[selectedGuid];
    const mesh = meshes.find((m) => m.guid === selectedGuid);
    const ifcClass = elem?.ifc_class || mesh?.ifc_class || '';
    const name = elem?.name || mesh?.name || ifcClass;

    if (WALL_CLASSES.includes(ifcClass) || ifcClass === 'IfcWall') {
      setActiveTool('WA', 'Architecture');
      setStatusMessage(`Create Similar: Wall (${name})`);
    } else if (ifcClass === 'IfcDoor') {
      setActiveTool('DR', 'Architecture');
      setStatusMessage(`Create Similar: Door (${name})`);
    } else if (ifcClass === 'IfcWindow') {
      setActiveTool('WN', 'Architecture');
      setStatusMessage(`Create Similar: Window (${name})`);
    } else if (ifcClass === 'IfcSlab') {
      startSketchMode('floor');
      setStatusMessage(`Create Similar: Floor (${name})`);
    } else if (ifcClass === 'IfcRoof') {
      startSketchMode('roof');
      setStatusMessage(`Create Similar: Roof (${name})`);
    } else {
      setStatusMessage(`Create Similar not supported for ${ifcClass || 'this element'}`);
    }
  },

  flipElementOrientation: async (guid: string) => {
    const { elements, updateElement, setStatusMessage } = get();
    const elem = elements[guid];
    if (!elem) return;

    if (elem.start && elem.end) {
      try {
        await updateElement(guid, {
          start: elem.end,
          end: elem.start,
        });
        setStatusMessage(`Flipped orientation of wall "${elem.name || guid}"`);
      } catch (e) {
        setStatusMessage(`Flip failed: ${failureMessage(e)}`);
      }
    } else if (elem.ifc_class === 'IfcDoor' || elem.swing_flipped !== undefined) {
      try {
        const flipped = !elem.swing_flipped;
        await updateElement(guid, {
          swing_flipped: flipped,
        });
        setStatusMessage(`Flipped door swing direction (${flipped ? 'flipped' : 'normal'})`);
      } catch (e) {
        setStatusMessage(`Flip failed: ${failureMessage(e)}`);
      }
    }
  },

  selectAllInstances: (categoryOrClass: string, onlyInActiveView = false) => {
    const { elements, meshes, sliced2D } = get();
    const isWall = categoryOrClass === 'IfcWall' || categoryOrClass.toLowerCase().includes('wall');
    const isDoor = categoryOrClass === 'IfcDoor' || categoryOrClass.toLowerCase().includes('door');
    const isWindow = categoryOrClass === 'IfcWindow' || categoryOrClass.toLowerCase().includes('window');
    const isSlab = categoryOrClass === 'IfcSlab' || categoryOrClass.toLowerCase().includes('slab') || categoryOrClass.toLowerCase().includes('floor');
    const isRoof = categoryOrClass === 'IfcRoof' || categoryOrClass.toLowerCase().includes('roof');

    const matchesClass = (cls: string) => {
      if (isWall) return WALL_CLASSES.includes(cls) || cls === 'IfcWall';
      if (isDoor) return cls === 'IfcDoor';
      if (isWindow) return cls === 'IfcWindow';
      if (isSlab) return cls === 'IfcSlab';
      if (isRoof) return cls === 'IfcRoof';
      return cls.toLowerCase() === categoryOrClass.toLowerCase();
    };

    let targetGuids: string[] = [];
    if (onlyInActiveView && sliced2D) {
      const inViewGuids = new Set<string>();
      sliced2D.cut_paths?.forEach((cp) => inViewGuids.add(cp.guid));
      sliced2D.slabs?.forEach((s) => inViewGuids.add(s.guid));
      sliced2D.roofs?.forEach((r) => inViewGuids.add(r.guid));
      targetGuids = Array.from(inViewGuids).filter((g) => {
        const el = elements[g];
        const m = meshes.find((mesh) => mesh.guid === g);
        const cls = el?.ifc_class || m?.ifc_class || '';
        return matchesClass(cls);
      });
    } else {
      const allGuids = Object.keys(elements);
      for (const m of meshes) {
        if (!allGuids.includes(m.guid)) allGuids.push(m.guid);
      }
      targetGuids = allGuids.filter((g) => {
        const el = elements[g];
        const m = meshes.find((mesh) => mesh.guid === g);
        const cls = el?.ifc_class || m?.ifc_class || '';
        return matchesClass(cls);
      });
    }

    if (targetGuids.length > 0) {
      get().setSelectedGuids(targetGuids);
      get().setStatusMessage(`Selected ${targetGuids.length} instances of ${categoryOrClass} (${onlyInActiveView ? 'in active view' : 'in entire project'})`);
    } else {
      get().setStatusMessage(`No instances found for ${categoryOrClass}`);
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
      set({ statusMessage: `Update georeferencing failed: ${failureMessage(e)}` });
      console.error('Failed to update georeferencing', e);
    }
  },

  createSheet: async (sheetNumber, sheetTitle, paperSize = 'ANSI_D', orientation = 'landscape') => {
    try {
      await get().dispatchTransaction('createSheet', {
        sheet_number: sheetNumber,
        sheet_title: sheetTitle,
        paper_size: paperSize,
        orientation,
      }, `Create Sheet ${sheetNumber}`);
    } catch (e) {
      set({ statusMessage: `Failed to create sheet: ${failureMessage(e)}` });
      console.error('Failed to create sheet', e);
      throw e;
    }
  },

  updateViewportScale: async (viewportId, scaleFactor, sheetId) => {
    try {
      const state = get();
      const sId = sheetId || state.activeSheetId;
      if (!sId) return;
      const targetSheet = state.sheets.find((s) => s.id === sId);
      if (!targetSheet) return;
      const updatedViewports = (targetSheet.viewports || []).map((vp) =>
        vp.id === viewportId ? { ...vp, scaleFactor } : vp
      );
      set({
        sheets: state.sheets.map((s) =>
          s.id === sId ? { ...s, viewports: updatedViewports } : s
        ),
      });
      await get().updateSheet(sId, { viewports: updatedViewports } as any);
    } catch (e) {
      set({ statusMessage: `Failed to update viewport scale: ${failureMessage(e)}` });
      console.error('Failed to update viewport scale', e);
      throw e;
    }
  },

  deleteSheet: async (sheetId) => {
    try {
      await get().dispatchTransaction('deleteSheet', { sheet_id: sheetId }, `Delete Sheet`);
    } catch (e) {
      set({ statusMessage: `Failed to delete sheet: ${failureMessage(e)}` });
      console.error('Failed to delete sheet', e);
      throw e;
    }
  },

  updateSheet: async (sheetId, updates) => {
    try {
      await get().dispatchTransaction('updateSheet', { sheet_id: sheetId, updates }, `Update Sheet`);
    } catch (e) {
      set({ statusMessage: `Failed to update sheet: ${failureMessage(e)}` });
      console.error('Failed to update sheet', e);
      throw e;
    }
  },

  addViewportToSheet: async (sheetId, viewId, x, y) => {
    try {
      const view = get().views.find((v) => v.id === viewId);
      let width = 480;
      let height = 360;
      if (view && view.type === 'drafting') {
        const drafts = get().draftEntities.filter((e) => e.viewId === viewId);
        const frame = draftingFrame(drafts, view.scaleDenominator || 12);
        width = Math.max(140, Math.round(frame.width));
        height = Math.max(100, Math.round(frame.height));
      }
      await get().dispatchTransaction('addViewportToSheet', {
        sheet_id: sheetId,
        view_id: viewId,
        x,
        y,
        width,
        height,
        scale_factor: 1.0,
      }, `Add Viewport to Sheet`);
    } catch (e) {
      set({ statusMessage: `Failed to add viewport: ${failureMessage(e)}` });
      console.error('Failed to add viewport', e);
      throw e;
    }
  },

  removeViewportFromSheet: async (viewportId, sheetId) => {
    try {
      await get().dispatchTransaction('removeViewportFromSheet', {
        viewport_id: viewportId,
        sheet_id: sheetId,
      }, `Remove Viewport`);
    } catch (e) {
      set({ statusMessage: `Failed to remove viewport: ${failureMessage(e)}` });
      console.error('Failed to remove viewport', e);
      throw e;
    }
  },

  moveViewport: async (viewportId, x, y, sheetId) => {
    try {
      await get().dispatchTransaction('moveViewport', {
        viewport_id: viewportId,
        x,
        y,
        sheet_id: sheetId,
      }, `Move Viewport`);
    } catch (e) {
      set({ statusMessage: `Failed to move viewport: ${failureMessage(e)}` });
      console.error('Failed to move viewport', e);
      throw e;
    }
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
      set({ statusMessage: `Export vector sheet PDF failed: ${failureMessage(e)}` });
      console.error('Failed to export vector sheet PDF', e);
    }
  },

  exportBatchPdf: async (sheetsData, filename = 'Batch_Sheets_Export') => {
    try {
      const payload = {
        sheets: sheetsData.map((s) => ({
          svg_content: s.svgContent,
          sheet_name: s.sheetName,
        })),
        filename,
      };

      const res = await fetch(`${API_BASE}/export/batch-pdf`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (res.ok) {
        const blob = await res.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${filename}.pdf`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        window.URL.revokeObjectURL(url);
      }
    } catch (e) {
      set({ statusMessage: `Export batch vector PDF failed: ${failureMessage(e)}` });
      console.error('Failed to export batch vector PDF', e);
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
      set({ statusMessage: `Export IFC failed: ${failureMessage(e)}` });
      console.error('Failed to export IFC', e);
    }
  },

  // Sheet Drafting & Annotation Actions (Phase 2)
  setActiveAnnotationTool: (tool) => set({ activeAnnotationTool: tool }),
  setActiveLayerId: (id) => set({ activeLayerId: id }),
  setActiveTextStyleId: (id) => set({ activeTextStyleId: id }),
  setActiveDimensionStyleId: (id) => set({ activeDimensionStyleId: id }),
  setSelectedAnnotationId: (id) => set({ selectedAnnotationId: id }),

  addSheetAnnotation: async (sheetId, annotation) => {
    try {
      const state = get();
      const sId = sheetId || state.activeSheetId;
      const targetSheet = state.sheets.find((s) => s.id === sId);
      if (!targetSheet) return;
      const newAnno: SheetAnnotation = {
        ...annotation,
        id: `anno-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      };
      const updatedAnnos = [...(targetSheet.annotations || []), newAnno];
      set({
        sheets: state.sheets.map((s) => (s.id === sId ? { ...s, annotations: updatedAnnos } : s)),
        selectedAnnotationId: newAnno.id,
      });
      await get().updateSheet(sId, { annotations: updatedAnnos } as any);
    } catch (e) {
      set({ statusMessage: `Failed to add sheet annotation: ${failureMessage(e)}` });
      console.error('Failed to add sheet annotation', e);
      throw e;
    }
  },

  updateSheetAnnotation: async (sheetId, annotationId, updates) => {
    try {
      const state = get();
      const sId = sheetId || state.activeSheetId;
      const targetSheet = state.sheets.find((s) => s.id === sId);
      if (!targetSheet) return;
      const updatedAnnos = (targetSheet.annotations || []).map((a) =>
        a.id === annotationId ? { ...a, ...updates } : a
      );
      set({
        sheets: state.sheets.map((s) => (s.id === sId ? { ...s, annotations: updatedAnnos } : s)),
      });
      await get().updateSheet(sId, { annotations: updatedAnnos } as any);
    } catch (e) {
      set({ statusMessage: `Failed to update sheet annotation: ${failureMessage(e)}` });
      console.error('Failed to update sheet annotation', e);
      throw e;
    }
  },

  removeSheetAnnotation: async (sheetId, annotationId) => {
    try {
      const state = get();
      const sId = sheetId || state.activeSheetId;
      const targetSheet = state.sheets.find((s) => s.id === sId);
      if (!targetSheet) return;
      const updatedAnnos = (targetSheet.annotations || []).filter((a) => a.id !== annotationId);
      set({
        sheets: state.sheets.map((s) => (s.id === sId ? { ...s, annotations: updatedAnnos } : s)),
        selectedAnnotationId: state.selectedAnnotationId === annotationId ? null : state.selectedAnnotationId,
      });
      await get().updateSheet(sId, { annotations: updatedAnnos } as any);
    } catch (e) {
      set({ statusMessage: `Failed to remove sheet annotation: ${failureMessage(e)}` });
      console.error('Failed to remove sheet annotation', e);
      throw e;
    }
  },

  duplicateSheet: async (sheetId: string) => {
    try {
      const state = get();
      const target = state.sheets.find((s) => s.id === sheetId);
      if (!target) return null;

      let baseNum = target.sheetNumber || 'A101';
      let nextNum = `${baseNum}-COPY`;
      const match = baseNum.match(/^(.*?)(\d+)$/);
      if (match) {
        const prefix = match[1];
        let numVal = parseInt(match[2], 10) + 1;
        while (state.sheets.some((s) => s.sheetNumber.toLowerCase() === `${prefix}${numVal}`.toLowerCase())) {
          numVal++;
        }
        nextNum = `${prefix}${numVal}`;
      } else {
        let copyIdx = 1;
        while (state.sheets.some((s) => s.sheetNumber.toLowerCase() === `${baseNum}-COPY${copyIdx > 1 ? copyIdx : ''}`.toLowerCase())) {
          copyIdx++;
        }
        nextNum = `${baseNum}-COPY${copyIdx > 1 ? copyIdx : ''}`;
      }

      const newTitle = `${target.sheetTitle} (Copy)`;
      await get().createSheet(nextNum, newTitle, target.paperSize, target.orientation);

      const updatedState = get();
      const newSheet = updatedState.sheets.find((s) => s.sheetNumber === nextNum);
      if (newSheet) {
        const clonedVps = (target.viewports || []).map((vp) => ({
          ...vp,
          id: `vp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        }));
        const clonedAnnos = (target.annotations || []).map((anno) => ({
          ...anno,
          id: `anno-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        }));
        const clonedRevs = (target.revisions || []).map((rev) => ({
          ...rev,
          id: `rev-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        }));

        await get().updateSheet(newSheet.id, {
          viewports: clonedVps,
          annotations: clonedAnnos,
          revisions: clonedRevs,
        });

        set({ activeSheetId: newSheet.id });
        set({ statusMessage: `Duplicated Sheet ${target.sheetNumber} -> ${nextNum}` });
        return newSheet.id;
      }
      return null;
    } catch (e) {
      set({ statusMessage: `Failed to duplicate sheet: ${failureMessage(e)}` });
      console.error('Failed to duplicate sheet', e);
      return null;
    }
  },

  addSheetRevision: async (sheetId: string, revision: Omit<SheetRevision, 'id'>) => {
    try {
      const state = get();
      const sId = sheetId || state.activeSheetId;
      const target = state.sheets.find((s) => s.id === sId);
      if (!target) return;
      const newRev: SheetRevision = {
        ...revision,
        id: `rev-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      };
      const updatedRevs = [...(target.revisions || []), newRev];
      set({
        sheets: state.sheets.map((s) => (s.id === sId ? { ...s, revisions: updatedRevs } : s)),
      });
      await get().updateSheet(sId, { revisions: updatedRevs } as any);
    } catch (e) {
      set({ statusMessage: `Failed to add revision: ${failureMessage(e)}` });
      console.error('Failed to add revision', e);
      throw e;
    }
  },

  updateSheetRevision: async (sheetId: string, revId: string, patch: Partial<SheetRevision>) => {
    try {
      const state = get();
      const sId = sheetId || state.activeSheetId;
      const target = state.sheets.find((s) => s.id === sId);
      if (!target) return;
      const updatedRevs = (target.revisions || []).map((r) => (r.id === revId ? { ...r, ...patch } : r));
      set({
        sheets: state.sheets.map((s) => (s.id === sId ? { ...s, revisions: updatedRevs } : s)),
      });
      await get().updateSheet(sId, { revisions: updatedRevs } as any);
    } catch (e) {
      set({ statusMessage: `Failed to update revision: ${failureMessage(e)}` });
      console.error('Failed to update revision', e);
      throw e;
    }
  },

  removeSheetRevision: async (sheetId: string, revId: string) => {
    try {
      const state = get();
      const sId = sheetId || state.activeSheetId;
      const target = state.sheets.find((s) => s.id === sId);
      if (!target) return;
      const updatedRevs = (target.revisions || []).filter((r) => r.id !== revId);
      set({
        sheets: state.sheets.map((s) => (s.id === sId ? { ...s, revisions: updatedRevs } : s)),
      });
      await get().updateSheet(sId, { revisions: updatedRevs } as any);
    } catch (e) {
      set({ statusMessage: `Failed to remove revision: ${failureMessage(e)}` });
      console.error('Failed to remove revision', e);
      throw e;
    }
  },

  dimAllViewport: async (sheetId: string, viewportId: string) => {
    try {
      const state = get();
      const sId = sheetId || state.activeSheetId;
      const targetSheet = state.sheets.find((s) => s.id === sId);
      if (!targetSheet) return;
      const vp = (targetSheet.viewports || []).find((v) => v.id === viewportId);
      if (!vp) return;

      const layer = state.draftingLayers.find((l) => l.name.toLowerCase().includes('dim')) || state.draftingLayers[0];
      const dimStyle = state.dimensionStyles[0];

      const offset = 25;
      const x1 = vp.x;
      const x2 = vp.x + vp.width;
      const y1 = vp.y;
      const y2 = vp.y + vp.height;

      const topDim: SheetAnnotation = {
        id: `anno-${Date.now()}-1`,
        kind: 'dimension',
        layerId: layer.id,
        points: [[x1, y1 - offset], [x2, y1 - offset]],
        styleId: dimStyle.id,
      };

      const leftDim: SheetAnnotation = {
        id: `anno-${Date.now()}-2`,
        kind: 'dimension',
        layerId: layer.id,
        points: [[x1 - offset, y2], [x1 - offset, y1]],
        styleId: dimStyle.id,
      };

      const midX = (x1 + x2) / 2;
      const bottomSub1: SheetAnnotation = {
        id: `anno-${Date.now()}-3`,
        kind: 'dimension',
        layerId: layer.id,
        points: [[x1, y2 + offset + 20], [midX, y2 + offset + 20]],
        styleId: dimStyle.id,
      };
      const bottomSub2: SheetAnnotation = {
        id: `anno-${Date.now()}-4`,
        kind: 'dimension',
        layerId: layer.id,
        points: [[midX, y2 + offset + 20], [x2, y2 + offset + 20]],
        styleId: dimStyle.id,
      };

      const updatedAnnos = [...(targetSheet.annotations || []), topDim, leftDim, bottomSub1, bottomSub2];
      set({
        sheets: state.sheets.map((s) => (s.id === sId ? { ...s, annotations: updatedAnnos } : s)),
        statusMessage: `DIMALL: Generated 4 automated boundary dimension strings for viewport`,
      });
      await get().updateSheet(sId, { annotations: updatedAnnos } as any);
    } catch (e) {
      set({ statusMessage: `DIMALL failed: ${failureMessage(e)}` });
      console.error('DIMALL failed', e);
    }
  },

  addDraftingLayer: (layer) => {
    set((state) => ({ draftingLayers: [...state.draftingLayers, layer] }));
  },

  updateDraftingLayer: (layerId, updates) => {
    set((state) => ({
      draftingLayers: state.draftingLayers.map((l) => (l.id === layerId ? { ...l, ...updates } : l)),
    }));
  },

  deleteDraftingLayer: (layerId) => {
    set((state) => {
      if (state.draftingLayers.length <= 1) return state;
      return {
        draftingLayers: state.draftingLayers.filter((l) => l.id !== layerId),
        activeLayerId: state.activeLayerId === layerId ? state.draftingLayers[0]?.id || '' : state.activeLayerId,
      };
    });
  },

  addLayerGroup: (group) => {
    set((state) => ({ layerGroups: [...state.layerGroups, group] }));
  },

  updateLayerGroup: (groupId, updates) => {
    set((state) => ({
      layerGroups: state.layerGroups.map((g) => (g.id === groupId ? { ...g, ...updates } : g)),
    }));
  },

  setDraftEntities: (entities) => set({ draftEntities: entities }),

  createDraftingView: (name, scale = '1" = 1\'-0"', scaleDenominator = 12) => {
    const id = `view-drafting-${Date.now()}`;
    const newView: ViewDefinition = {
      id,
      name,
      type: 'drafting',
      scale,
      scaleDenominator,
      detailLevel: 'fine',
      visualStyle: 'hidden_line',
      viewRange: {
        top: 8.0,
        cut: 4.0,
        bottom: 0.0,
        viewDepth: 0.0,
      },
    };
    set((state) => ({
      views: [...state.views, newView],
      activeViewId: id,
    }));
    return id;
  },

  deleteDraftingView: (viewId) => {
    set((state) => ({
      views: state.views.filter((v) => v.id !== viewId),
      draftEntities: state.draftEntities.filter((e) => e.viewId !== viewId),
      activeViewId: state.activeViewId === viewId ? (state.views[0]?.id || 'view-3d') : state.activeViewId,
    }));
  },

  addDraftEntity: (entity) => {
    const id = `draft-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    const fullEntity: DraftEntity = { ...entity, id };
    set((state) => ({
      draftEntities: [...state.draftEntities, fullEntity],
    }));
    return id;
  },

  updateDraftEntity: (id, updates) => {
    set((state) => ({
      draftEntities: state.draftEntities.map((e) => (e.id === id ? { ...e, ...updates } : e)),
    }));
  },

  removeDraftEntity: (id) => {
    set((state) => ({
      draftEntities: state.draftEntities.filter((e) => e.id !== id),
    }));
  },

  fetchTypes: async () => {
    try {
      const res = await fetch(`${API_BASE}/types`);
      if (res.ok) {
        const types = await res.json();
        set({ types });
      }
    } catch (e) {
      console.error('Failed to fetch types', e);
    }
  },

  setElementType: async (guid: string, typeId: string) => {
    try {
      await get().dispatchTransaction(
        'setElementType',
        { guid, type_id: typeId },
        `Set element type to ${typeId}`
      );
    } catch (e) {
      set({ statusMessage: `Set element type failed: ${failureMessage(e)}` });
      console.error('Failed to set element type', e);
      throw e;
    }
  },

  updateType: async (typeId: string, parameters: Record<string, any>) => {
    try {
      await get().dispatchTransaction(
        'updateType',
        { type_id: typeId, parameters },
        `Update type ${typeId}`
      );
    } catch (e) {
      set({ statusMessage: `Update type failed: ${failureMessage(e)}` });
      console.error('Failed to update type', e);
      throw e;
    }
  },

  duplicateType: async (sourceTypeId: string, newTypeId: string, newName: string) => {
    try {
      await get().dispatchTransaction(
        'duplicateType',
        { source_type_id: sourceTypeId, new_type_id: newTypeId, new_name: newName },
        `Duplicate type ${sourceTypeId}`
      );
    } catch (e) {
      set({ statusMessage: `Duplicate type failed: ${failureMessage(e)}` });
      console.error('Failed to duplicate type', e);
      throw e;
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
      set({ statusMessage: `Export .bimworks project failed: ${failureMessage(e)}` });
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

      set({ rev: undefined, docId: undefined });
      await get().fetchStateBundle();

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
      set({ statusMessage: `Add sketch curve failed: ${failureMessage(e)}` });
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
      set({ statusMessage: `Move sketch vertex failed: ${failureMessage(e)}` });
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
      set({ statusMessage: `Move sketch edge failed: ${failureMessage(e)}` });
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
      set({ statusMessage: `Set sketch slope failed: ${failureMessage(e)}` });
      console.error('Failed to set sketch slope', e);
    }
  },

  copyElement: async (guid, dx, dy, dz = 0.0) => {
    try {
      await get().dispatchTransaction('copyElement', { guid, dx, dy, dz }, 'Copy element');
    } catch (e) {
      set({ statusMessage: `Copy element failed: ${failureMessage(e)}` });
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
      set({ statusMessage: `Rotate element failed: ${failureMessage(e)}` });
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
      set({ statusMessage: `Offset element failed: ${failureMessage(e)}` });
      console.error('Failed to offset element', e);
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
      set({ statusMessage: `Move level failed: ${failureMessage(e)}` });
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
      set({ statusMessage: `Set wall join failed: ${failureMessage(e)}` });
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
        // UI-P0-3: FastAPI returns a *list* of objects in `detail` for a Pydantic
        // validation failure, and `new Error(list)` stringifies that to
        // "[object Object],[object Object]". Flatten it to field + reason so the
        // status bar can say something true about a rejected command.
        throw new Error(describeApiError(err.detail));
      }

      const data = await res.json();
      if (data?.conflict) {
        const c = data.conflict;
        const msg = `Constraint Conflict on ${c.axis || 'solve'} axis: ${c.constraints?.length || 0} conflicting constraints.`;
        set({ statusMessage: msg });
      }
      const clampReason = data?.results?.find((r: any) => r?.result?.clamp_reason)?.result?.clamp_reason;
      if (clampReason) {
        set({ statusMessage: clampReason });
      }
      // View state is refreshed from the engine after every commit; the store
      // holds no independent model state. This is ONE round trip: the previous
      // sequence issued seven serial requests and fetched /api/constraints twice.
      await get().fetchStateBundle();

      return data;
    } catch (e) {
      console.error('executeTransaction error:', e);
      throw e;
    }
  },

  dispatchTransaction: async (action, params, description = 'Edit') => {
    const command = UI_ACTION_COMMANDS[action];
    const dragSessionId = get().activeDragSessionId;
    if (dragSessionId) {
      // Gesture in progress mode (Track B Phase 2)
      activeDragTracking = {
        action,
        params: { ...params },
        guid: (params.guid || '') as string,
        paramKey: params.height !== undefined ? 'height' : (params.thickness !== undefined ? 'thickness' : (params.end !== undefined ? 'length' : 'value')),
      };
      const res = await fetch(`${API_BASE}/drag/update`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: dragSessionId,
          commands: [{ command, params, origin: 'ui' }],
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(describeApiError(err));
      }
      const data = await res.json();
      if (data?.clamp_reason) {
        set({ statusMessage: data.clamp_reason });
      }
      if (data.changed_meshes && Array.isArray(data.changed_meshes)) {
        set((state) => {
          const meshMap = new Map(state.meshes.map((m) => [m.guid, m]));
          for (const m of data.changed_meshes) {
            meshMap.set(m.guid, m);
          }
          return { meshes: Array.from(meshMap.values()) };
        });
      }
      return data;
    }

    const result = await get().executeTransaction(
      [{ command, params, origin: 'ui' }],
      'ui',
      description || command
    );
    const targetGuid = (params.guid || (result.results?.[0]?.result?.guid)) as string;
    if (targetGuid) {
      set({
        lastGestureCommit: {
          action,
          params: { ...params },
          paramKey: params.height !== undefined ? 'height' : (params.thickness !== undefined ? 'thickness' : (params.end !== undefined ? 'length' : 'value')),
          guid: targetGuid,
        },
      });
    }
    return result;
  },

  beginDrag: async (description = 'Drag gesture') => {
    activeDragTracking = null;
    cancelPendingBeginDrag = false;
    const beginPromise = (async () => {
      const res = await fetch(`${API_BASE}/drag/begin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ origin: 'ui', description }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(describeApiError(err));
      }
      const data = await res.json();
      if (cancelPendingBeginDrag) {
        // Fast release aborted gesture before begin completed: end session cleanly without commit
        fetch(`${API_BASE}/drag/end`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id: data.session_id, commit: false }),
        }).catch(() => {});
        set({ activeDragSessionId: null });
        return null;
      }
      set({ activeDragSessionId: data.session_id });
      return data.session_id;
    })();
    pendingBeginDragPromise = beginPromise;
    try {
      return await beginPromise;
    } finally {
      if (pendingBeginDragPromise === beginPromise) {
        pendingBeginDragPromise = null;
      }
    }
  },

  endDrag: async (commit = true) => {
    if (pendingBeginDragPromise) {
      cancelPendingBeginDrag = true;
      await pendingBeginDragPromise.catch(() => {});
      pendingBeginDragPromise = null;
    }
    const dragSessionId = get().activeDragSessionId;
    if (!dragSessionId) return null;
    set({ activeDragSessionId: null });
    const res = await fetch(`${API_BASE}/drag/end`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: dragSessionId, commit }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(describeApiError(err));
    }
    const data = await res.json();
    if (commit && activeDragTracking && activeDragTracking.action && activeDragTracking.guid) {
      set({
        lastGestureCommit: {
          action: activeDragTracking.action,
          params: { ...activeDragTracking.params },
          paramKey: activeDragTracking.paramKey || 'value',
          guid: activeDragTracking.guid,
        },
      });
    }
    activeDragTracking = null;
    await get().fetchStateBundle();
    return data;
  },

  retypeCommittedValue: async (rawInput: string) => {
    const { lastGestureCommit, undoTransaction, dispatchTransaction, elements } = get();
    if (!lastGestureCommit) return false;

    const feet = tryParseLength(rawInput);
    if (feet === null || feet <= 0) return false;

    // 1. Undo the just-committed transaction
    await undoTransaction();

    // 2. Re-dispatch the transaction with the corrected value
    const updatedParams = { ...lastGestureCommit.params };

    if (lastGestureCommit.action === 'modifyWallHeight') {
      updatedParams.height = feet;
    } else if (lastGestureCommit.action === 'modifyWallThickness') {
      updatedParams.thickness = feet;
    } else if (lastGestureCommit.action === 'modifyWallEnd') {
      const el = elements[lastGestureCommit.guid];
      if (el && el.start && el.end) {
        const isStart = updatedParams.end === 'start';
        const fixedPt = isStart ? el.end : el.start;
        const movingPt = isStart ? el.start : el.end;
        const dx = movingPt[0] - fixedPt[0];
        const dy = movingPt[1] - fixedPt[1];
        const curLen = Math.hypot(dx, dy);
        if (curLen > 0.001) {
          const ratio = feet / curLen;
          const newPt = [fixedPt[0] + dx * ratio, fixedPt[1] + dy * ratio, movingPt[2] ?? 0];
          updatedParams.point = newPt;
        }
      }
    } else if (lastGestureCommit.action === 'modifyOpeningOffset') {
      updatedParams.offset = feet;
    } else if (lastGestureCommit.action === 'modifyOpeningWidth') {
      updatedParams.width = feet;
    } else if (lastGestureCommit.action === 'modifyOpeningSillHeight') {
      updatedParams.sill_height = feet;
    } else if (lastGestureCommit.action === 'createWall') {
      const sp = updatedParams.start as [number, number, number];
      const ep = updatedParams.end as [number, number, number];
      if (sp && ep) {
        const dx = ep[0] - sp[0];
        const dy = ep[1] - sp[1];
        const curLen = Math.hypot(dx, dy);
        if (curLen > 0.001) {
          const ratio = feet / curLen;
          updatedParams.end = [sp[0] + dx * ratio, sp[1] + dy * ratio, sp[2] ?? 0];
        }
      }
    }

    await dispatchTransaction(
      lastGestureCommit.action,
      updatedParams,
      `Retype ${lastGestureCommit.action}`
    );

    return true;
  },

  undoTransaction: async () => {
    try {
      const res = await fetch(`${API_BASE}/transaction/undo`, { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        set({ statusMessage: `Undone transaction (${data.description || 'Done'})` });
        await get().fetchStateBundle();
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
        await get().fetchStateBundle();
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
    // 1. First attempt backend typesafe AI Driver planner
    try {
      const selected = get().selectedGuid ? [get().selectedGuid!] : [];
      const res = await fetch(`${API_BASE}/ai/plan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: promptText,
          active_view_id: get().activeViewId,
          selected_guids: selected,
        }),
      });
      if (res.ok) {
        const backendPlan = await res.json();
        if (backendPlan && backendPlan.commands && backendPlan.commands.length > 0) {
          return backendPlan as AiPlan;
        }
      }
    } catch {
      // Fallback to client planner if engine is offline or in mock test mode
    }

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
        intentSummary: `Insert 36" × 84" Single Flush Door into host wall at ${formatLength(offsetVal, get().displayUnit)} from its start`,
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
        intentSummary: `Insert 48" × 48" Fixed Window into host wall at ${formatLength(winOffset, get().displayUnit)} from its start`,
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
      set({ statusMessage: `Commit AI Plan: failed: ${failureMessage(e)}` });
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
    // Discard the pending sketch point and any open dimension editor, so the next
    // sketch cannot start with the previous one's half-drawn segment (UI-P0-11).
    get().resetInteraction('sketch-cancel');
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
      get().resetInteraction('sketch-finish');
      await get().fetchStateBundle();
      return true;
    } catch (e: any) {
      set({ statusMessage: `Finish sketch: failed: ${failureMessage(e)}` });
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

