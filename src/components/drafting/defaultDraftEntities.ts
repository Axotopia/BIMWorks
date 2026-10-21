import { DraftEntity } from '../../types/bim';

/**
 * Default architectural drafting entities for the sample Parapet Detail view (`view-drafting-parapet`).
 * Demonstrates 2D drafting entities (polylines, lines, hatches, dimensions, leaders, and levels)
 * modeled directly in drawing space without requiring a 3D IFC model.
 */
export const DEFAULT_DRAFT_ENTITIES: DraftEntity[] = [
  // 1. Concrete Parapet Wall (Main structure)
  {
    id: 'draft-wall-outline',
    viewId: 'view-drafting-parapet',
    layerId: 'layer-draft-medium',
    shape: {
      type: 'polyline',
      pts: [
        { x: 0, y: 0 },
        { x: 300, y: 0 },
        { x: 300, y: 900 },
        { x: 0, y: 900 },
      ],
      closed: true,
    },
  },
  // Concrete hatch pattern inside the parapet curb
  {
    id: 'draft-wall-hatch',
    viewId: 'view-drafting-parapet',
    layerId: 'layer-draft-hatch',
    shape: {
      type: 'hatch',
      loops: [
        [
          { x: 5, y: 5 },
          { x: 295, y: 5 },
          { x: 295, y: 895 },
          { x: 5, y: 895 },
        ],
      ],
      pattern: 'diagonal',
      scale: 15,
      angle: 45,
      color: '#475569',
    },
  },
  // 2. Concrete Roof Slab (Extending inward to the left)
  {
    id: 'draft-roof-slab',
    viewId: 'view-drafting-parapet',
    layerId: 'layer-draft-medium',
    shape: {
      type: 'polyline',
      pts: [
        { x: 0, y: 200 },
        { x: -500, y: 200 },
        { x: -500, y: 0 },
        { x: 0, y: 0 },
      ],
      closed: true,
    },
  },
  // 3. Rigid Insulation on roof deck and up the interior face of parapet
  {
    id: 'draft-insulation-roof',
    viewId: 'view-drafting-parapet',
    layerId: 'layer-draft-fine',
    shape: {
      type: 'polyline',
      pts: [
        { x: -500, y: 200 },
        { x: 0, y: 200 },
        { x: 0, y: 260 },
        { x: -500, y: 260 },
      ],
      closed: true,
    },
  },
  {
    id: 'draft-insulation-inner-wall',
    viewId: 'view-drafting-parapet',
    layerId: 'layer-draft-fine',
    shape: {
      type: 'polyline',
      pts: [
        { x: 0, y: 260 },
        { x: 60, y: 260 },
        { x: 60, y: 860 },
        { x: 0, y: 860 },
      ],
      closed: true,
    },
  },
  // 4. Coping Cap on Top (Slightly wider than 300mm with drips on both sides)
  {
    id: 'draft-coping-cap',
    viewId: 'view-drafting-parapet',
    layerId: 'layer-draft-heavy',
    shape: {
      type: 'polyline',
      pts: [
        { x: -25, y: 870 },
        { x: -25, y: 920 },
        { x: 325, y: 920 },
        { x: 325, y: 870 },
        { x: 320, y: 870 },
        { x: 320, y: 915 },
        { x: -20, y: 915 },
        { x: -20, y: 870 },
      ],
      closed: true,
    },
  },
  // 5. Roof Membrane Flashing & Cant Strip (45-degree angle)
  {
    id: 'draft-cant-strip',
    viewId: 'view-drafting-parapet',
    layerId: 'layer-draft-medium',
    shape: {
      type: 'polyline',
      pts: [
        { x: 60, y: 260 },
        { x: 120, y: 260 },
        { x: 60, y: 320 },
      ],
      closed: true,
    },
  },
  {
    id: 'draft-membrane-line',
    viewId: 'view-drafting-parapet',
    layerId: 'layer-draft-heavy',
    shape: {
      type: 'polyline',
      pts: [
        { x: -500, y: 265 },
        { x: 125, y: 265 },
        { x: 65, y: 325 },
        { x: 65, y: 650 },
        { x: 80, y: 650 },
      ],
      closed: false,
    },
  },
  // 6. Aligned Dimensions
  // Parapet width dimension (300 mm)
  {
    id: 'draft-dim-parapet-width',
    viewId: 'view-drafting-parapet',
    layerId: 'layer-anno-dims',
    shape: {
      type: 'dimension',
      variant: 'aligned',
      a: { x: 0, y: 950 },
      b: { x: 300, y: 950 },
      at: { x: 150, y: 970 },
      height: 12,
      text: '300 mm',
    },
  },
  // Parapet height above roof dimension (700 mm)
  {
    id: 'draft-dim-parapet-height',
    viewId: 'view-drafting-parapet',
    layerId: 'layer-anno-dims',
    shape: {
      type: 'dimension',
      variant: 'aligned',
      a: { x: 340, y: 200 },
      b: { x: 340, y: 900 },
      at: { x: 380, y: 550 },
      height: 12,
      text: '700 mm',
    },
  },
  // 7. Spot Elevation / Level mark at roof deck
  {
    id: 'draft-level-roof',
    viewId: 'view-drafting-parapet',
    layerId: 'layer-anno-note',
    shape: {
      type: 'level',
      p: { x: -450, y: 200 },
      value: 12.500,
      height: 12,
    },
  },
  // 8. Text Leaders
  {
    id: 'draft-leader-coping',
    viewId: 'view-drafting-parapet',
    layerId: 'layer-anno-lead',
    shape: {
      type: 'leader',
      pts: [
        { x: 150, y: 920 },
        { x: 220, y: 1050 },
        { x: 380, y: 1050 },
      ],
      text: 'ALUMINUM COPING CAP W/ DRIP EDGES',
      height: 10,
    },
  },
  {
    id: 'draft-leader-membrane',
    viewId: 'view-drafting-parapet',
    layerId: 'layer-anno-lead',
    shape: {
      type: 'leader',
      pts: [
        { x: 65, y: 480 },
        { x: -80, y: 600 },
        { x: -300, y: 600 },
      ],
      text: 'EPDM ROOF MEMBRANE BASE FLASHING',
      height: 10,
    },
  },
  {
    id: 'draft-leader-insulation',
    viewId: 'view-drafting-parapet',
    layerId: 'layer-anno-lead',
    shape: {
      type: 'leader',
      pts: [
        { x: 30, y: 500 },
        { x: -120, y: 450 },
        { x: -320, y: 450 },
      ],
      text: '60mm RIGID POLYISOCYANURATE INSULATION',
      height: 10,
    },
  },
  {
    id: 'draft-leader-cant',
    viewId: 'view-drafting-parapet',
    layerId: 'layer-anno-lead',
    shape: {
      type: 'leader',
      pts: [
        { x: 80, y: 280 },
        { x: 180, y: 120 },
        { x: 320, y: 120 },
      ],
      text: 'TREATED WOOD CANT STRIP',
      height: 10,
    },
  },
];
