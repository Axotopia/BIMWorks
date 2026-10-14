export type IfcClass =
  | 'IfcWallStandardCase'
  | 'IfcWall'
  | 'IfcDoor'
  | 'IfcWindow'
  | 'IfcSlab'
  | 'IfcRoof'
  | 'IfcGrid'
  | 'IfcBuildingStorey';

export interface BimElement {
  guid: string;
  ifc_class: IfcClass;
  name: string;
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

export interface Sliced2DData {
  cut_paths: Array<{ guid: string; class: string; d: string; fill?: string }>;
  projection_paths: Array<{ guid: string; class: string; d: string }>;
  swing_paths: Array<{ guid: string; class: string; d: string }>;
  slabs: Array<{ guid: string; d: string; class: string }>;
  grids: Array<{ guid: string; tag: string; d: string; circle_center: [number, number] }>;
  dimensions: Array<{
    guid: string;
    start: [number, number];
    end: [number, number];
    length: number;
    text: string;
    offset_norm: [number, number];
  }>;
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
  | 'SHT' // Sheet
  | 'BX' // Section Box
  | 'AL' // Align & Lock
  | 'EQ'; // Equalize

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

