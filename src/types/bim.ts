export type IfcClass =
  | 'IfcWallStandardCase'
  | 'IfcWall'
  | 'IfcDoor'
  | 'IfcWindow'
  | 'IfcSlab'
  | 'IfcRoof'
  | 'IfcGrid'
  | 'IfcBuildingStorey';

export interface BimTypeLayer {
  function: string;
  material: string;
  thickness: number;
}

export interface BimType {
  id: string;
  name: string;
  ifc_class: string;
  family_name?: string;
  parameters: {
    thickness?: number;
    height?: number;
    width?: number;
    sill_height?: number;
    fire_rating?: string;
    function?: string;
    layers?: BimTypeLayer[];
    [key: string]: any;
  };
}

export interface BimElement {
  guid: string;
  ifc_class: IfcClass;
  name: string;
  type_id?: string;
  start?: [number, number, number];
  end?: [number, number, number];
  length?: number;
  height?: number;
  thickness?: number;
  angle?: number;
  level_id?: string;
  host_wall_guid?: string;
  offset_along_wall?: number;
  width?: number;
  sill_height?: number;
  swing_flipped?: boolean;
  polygon?: [number, number][];
  elevation?: number;
  pitch?: number;
  tag?: string;
  type_properties?: Record<string, string>;
}

export interface MeshBufferData {
  guid: string;
  ifc_class: string;
  name: string;
  vertices: number[];
  indices: number[];
  color: string;
  cut_color: string;
  opacity: number;
  bbox: {
    min: [number, number, number];
    max: [number, number, number];
  };
  /**
   * Parametric definition of the element (baseline, hosting, offsets) as it
   * exists in the engine's `element_meta`. A tessellated bbox cannot express
   * these, so they are the authoritative source for the element record.
   */
  params?: ElementParams;
}

/** Serializable subset of the engine's per-element parametric metadata. */
export interface ElementParams {
  guid: string;
  ifc_class: string;
  name?: string;
  type_id?: string;
  start?: [number, number, number];
  end?: [number, number, number];
  length?: number;
  height?: number;
  thickness?: number;
  angle?: number;
  level_id?: string;
  host_wall_guid?: string;
  offset_along_wall?: number;
  width?: number;
  sill_height?: number;
  swing_flipped?: boolean;
  polygon?: [number, number][];
  elevation?: number;
  pitch?: number;
  tag?: string;
  type_properties?: Record<string, string>;
  hosted_openings?: string[];
}

export interface LevelData {
  id: string;
  name: string;
  elevation: number;
}

export interface GridData {
  guid: string;
  name: string;
  tag: string;
  start: [number, number];
  end: [number, number];
}

/**
 * A normalized geometric reference, as emitted by `backend/references.py`.
 *
 * `sources` carries element provenance — two entries for derived kinds such as `intersection`.
 * `hint` is repair data and is never identity. `guid` is a convenience mirror of `sources[0]` and
 * is absent for hint-only point references, so consumers must not assume it is present.
 */
export interface GeometricReference {
  kind?: string;
  sources?: Array<{ element_guid: string; ordinal?: number }>;
  hint?: {
    point?: [number, number, number] | null;
    normal?: [number, number, number] | null;
  } | null;
  /** Backward-compatible primary guid; absent when the reference has no element source. */
  guid?: string | null;
  /** Backward-compatible semantic string from the legacy `{ guid, ref }` form. */
  ref?: string;
  /** Legacy free-point coordinates accepted on input. */
  point?: [number, number] | [number, number, number];
}

export interface Sliced2DData {
  cut_paths: Array<{ guid: string; class: string; d: string; fill?: string }>;
  projection_paths: Array<{ guid: string; class: string; d: string }>;
  swing_paths: Array<{ guid: string; class: string; d: string }>;
  // Occluded geometry, separated by the hidden-line renderer. Drawn dashed and light.
  hidden_paths?: Array<{ guid: string; class: string; d: string }>;
  // Window glazing/jamb symbols. Annotation, not geometry, so they are a separate
  // drive from door swings.
  window_paths?: Array<{ guid: string; class: string; d: string }>;
  // Which renderer produced this view ("mesh-hlr" | "hlr" | "analytic").
  renderer?: string;
  // Which storey this plan draws, and where its cut plane landed. A plan is level-relative,
  // so `cut_elevation` is an offset above `level_elevation` and `cut_absolute` is the
  // resulting model elevation.
  level_id?: string | null;
  level_name?: string | null;
  level_elevation?: number;
  cut_absolute?: number;
  plan_rotation?: number;
  partitions?: { cut: number; projection: number; hidden: number; below?: number };
  view_range?: Record<string, number>;
  lineweights?: Record<string, { weight_mm: number; pattern: string; colour: string }>;
  slabs: Array<{ guid: string; d: string; class: string }>;
  roofs?: Array<{
    guid: string;
    name: string;
    d: string;
    ridge_d?: string;
    pitch: number;
    pitch_text?: string;
    center?: [number, number];
    class: string;
    is_overhead?: boolean;
  }>;
  grids: Array<{ guid: string; tag: string; d: string; circle_center: [number, number] }>;
  levels?: Array<{
    id: string;
    name: string;
    elevation: number;
    text: string;
    elevation_text?: string;
    d: string;
    circle_center: [number, number];
    class?: string;
  }>;
  /**
   * Dimension strings for the view. `status` reconciles the persisted dimension status with a
   * fresh reference resolution: `exact` | `repaired` | `ambiguous` | `lost`.
   *
   * An entry with `status: 'lost'` has `start`/`end` null and its `length`/`text` are the last
   * stored values, NOT a live measurement — the witnesses cannot be resolved, so there is nothing
   * to measure. Consumers must key off `status`, never off `text`.
   */
  dimensions: Array<{
    id?: string;
    guid?: string | null;
    kind?: string;
    start?: [number, number] | null;
    end?: [number, number] | null;
    length: number;
    text: string;
    offset_norm?: [number, number] | null;
    is_locked?: boolean;
    ref_a?: GeometricReference;
    ref_b?: GeometricReference;
    axis?: string;
    status?: string;
  }>;
}

export interface OverlayDimension {
  id: string;
  kind: 'aligned' | 'linear' | 'angular' | 'radial';
  ref_a: GeometricReference;
  ref_b: GeometricReference;
  axis: 'x' | 'y' | 'aligned';
  offset: number;
  value: number;
  is_locked: boolean;
  constraint_id?: string | null;
  eq_group?: string | null;
}

export type ViewType = 'floor_plan' | '3d' | 'section' | 'elevation' | 'sheet';

export interface ViewDefinition {
  id: string;
  name: string;
  type: ViewType;
  levelId?: string;
  scale: string;
  detailLevel: 'coarse' | 'medium' | 'fine';
  visualStyle: 'wireframe' | 'hidden_line' | 'consistent_colors';
  viewRange: {
    top: number;
    cut: number;
    bottom: number;
    viewDepth: number;
  };
  sectionBox?: {
    enabled: boolean;
    min: [number, number, number];
    max: [number, number, number];
  };
  line?: { start: [number, number]; end: [number, number] };
}

export interface SheetViewport {
  id: string;
  viewId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  scaleFactor: number;
}

export interface SheetDefinition {
  id: string;
  sheetNumber: string;
  sheetTitle: string;
  paperSize: 'ARCH_D' | 'ARCH_C' | 'ISO_A1';
  viewports: SheetViewport[];
  projectName: string;
  date: string;
  drawnBy: string;
}

export interface TemporaryDimension {
  elementGuid: string;
  distance: number;
  displayValue: string;
  witnessP1: [number, number, number];
  witnessP2: [number, number, number];
  center: [number, number, number];
  axis: 'x' | 'y';
}

export interface ParametricConstraint {
  id: string;
  type: 'align' | 'dimension_lock' | 'equalize';
  ref_guid?: string;
  target_guid?: string;
  axis?: 'x' | 'y' | 'z';
  offset?: number;
  guid_a?: string;
  guid_b?: string;
  locked_distance?: number;
  span_start_guid?: string;
  span_end_guid?: string;
  interior_guids?: string[];
  spacing?: number;
  is_locked: boolean;
  is_equalized?: boolean;
}

export type ActiveTool =
  | 'select'
  | 'WA' // Wall
  | 'DR' // Door
  | 'WN' // Window
  | 'SB' // Slab
  | 'RF' // Roof
  | 'GR' // Grid
  | 'LL' // Level
  | 'DI' // Aligned Dimension
  | 'DL' // Detail Line
  | 'TG' // Tag
  | 'TX' // Text
  | 'SEC' // Section
  | 'EL' // Elevation
  | 'SHT' // Sheet
  | 'BX' // Section Box
  | 'AL' // Align & Lock
  | 'EQ' // Equalize
  | 'TR' // Trim / Extend to Corner
  | 'SL' // Split Element
  | 'SO' // Split with Gap
  | 'sketch'; // Revit Sketch Mode (Edit Boundary / Edit Footprint / Create)

export interface SketchLine {
  id: string;
  start: [number, number];
  end: [number, number];
  definesSlope?: boolean; // For roof sketch lines
  slopeAngle?: number;    // Slope angle in degrees (e.g. 15.0 or 30.0)
  overhang?: number;      // Overhang offset in meters
  pickedWallGuid?: string; // Associated wall constraint
}

export type SketchDrawTool = 'line' | 'rectangle' | 'pick_walls';

export interface SketchSession {
  mode: 'floor' | 'roof';
  elementType: 'floor' | 'roof';
  isEditingExisting: boolean;
  targetGuid?: string;
  targetName?: string;
  elevation: number;
  thickness: number;
  pitch: number;
  lines: SketchLine[];
  selectedLineId: string | null;
  drawTool: SketchDrawTool;
  defaultDefinesSlope: boolean;
  defaultSlopeAngle: number;
  defaultOverhang: number;
  spanDirection?: [number, number];
  validationError?: string | null;
}

export interface WallJoinPolicy {
  allow_join: boolean;
  mode: 'butt' | 'miter' | 'square_off';
}

export interface WallJoinState {
  end0: WallJoinPolicy;
  end1: WallJoinPolicy;
}

export interface CommandPayload {
  command: string;
  params: Record<string, any>;
  origin?: 'ui' | 'ai' | 'script' | 'cli';
}

export interface TransactionPayload {
  commands: CommandPayload[];
  origin?: 'ui' | 'ai' | 'script' | 'cli';
  description?: string;
}

export interface AiPlan {
  intentSummary: string;
  commands: CommandPayload[];
  explanation?: string;
  affectedGuids?: string[];
}

export interface TransactionJournalEntry {
  transaction_id: string;
  origin: 'ui' | 'ai' | 'script' | 'cli';
  description: string;
  timestamp: number;
  commands: CommandPayload[];
  results?: any[];
}

