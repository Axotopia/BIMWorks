/**
 * Direct Manipulation — Grips Layer for Architectural Elements.
 *
 * Implements per-element grips that emit typed parameter commands rather
 * than raw geometry modifications.
 *
 * Supported element grips:
 * - Walls: 2 End grips (baseline), 1 Height grip, 2 Thickness grips
 * - Openings: offset along wall, width, sill height, flip orientation
 * - Grids: start and end points
 * - Slabs/Roofs: polygon vertices
 * - Levels: elevation
 */

export type GripKind =
  | 'wall_start'
  | 'wall_end'
  | 'wall_height'
  | 'wall_thickness_pos'
  | 'wall_thickness_neg'
  | 'opening_offset'
  | 'opening_width'
  | 'opening_sill_height'
  | 'opening_flip'
  | 'grid_start'
  | 'grid_end'
  | 'polygon_vertex'
  | 'level_elevation';

export interface Grip {
  id: string;
  elementGuid: string;
  kind: GripKind;
  worldPoint: [number, number, number];
  axis: [number, number, number];
  value: number;
  unit: string;
  range?: [number, number];
  ref?: {
    guid: string;
    ref: string;
    kind: string;
    sources?: Array<{ element_guid: string; ref_type: string }>;
  };
  label: string;
  meta?: Record<string, any>;
}

export interface GripDragResult {
  action:
    | 'modifyWallHeight'
    | 'modifyWallThickness'
    | 'modifyWallEnd'
    | 'modifyOpeningOffset'
    | 'modifyOpeningWidth'
    | 'modifyOpeningSillHeight'
    | 'flipOpening'
    | 'modifyGridEndpoint'
    | 'modifyPolygonVertex'
    | 'moveLevel';
  command:
    | 'WallSetHeight'
    | 'WallSetThickness'
    | 'WallSetEnd'
    | 'OpeningSetOffset'
    | 'OpeningSetWidth'
    | 'OpeningSetSillHeight'
    | 'OpeningFlip'
    | 'GridSetEndpoint'
    | 'PolygonSetVertex'
    | 'LevelMove';
  params: Record<string, any>;
  previewValue: number;
}

/**
 * Returns all active direct-manipulation grips for an element.
 */
export function gripsFor(element: any, context?: any): Grip[] {
  if (!element || (!element.guid && !element.id)) return [];
  const guid = element.guid || element.id;

  // 1. Grids
  const isGrid =
    element.ifc_class === 'IfcGrid' ||
    (element.start && element.end && (element.tag || element.ifc_class?.includes('Grid')));

  if (isGrid && element.start && element.end) {
    const sx = Number(element.start[0]);
    const sy = Number(element.start[1]);
    const ex = Number(element.end[0]);
    const ey = Number(element.end[1]);
    const dx = ex - sx;
    const dy = ey - sy;
    const len = Math.hypot(dx, dy);
    if (len < 0.001) return [];
    const ux = dx / len;
    const uy = dy / len;
    const tag = element.tag || element.name || '';

    return [
      {
        id: `${guid}:grid_start`,
        elementGuid: guid,
        kind: 'grid_start',
        worldPoint: [sx, sy, 0],
        axis: [-ux, -uy, 0],
        value: len,
        unit: 'ft',
        range: [0.5, 1000.0],
        label: `Grid ${tag} Start`,
      },
      {
        id: `${guid}:grid_end`,
        elementGuid: guid,
        kind: 'grid_end',
        worldPoint: [ex, ey, 0],
        axis: [ux, uy, 0],
        value: len,
        unit: 'ft',
        range: [0.5, 1000.0],
        label: `Grid ${tag} End`,
      },
    ];
  }

  // 2. Openings (Doors & Windows)
  const isOpening =
    element.ifc_class === 'IfcDoor' ||
    element.ifc_class === 'IfcWindow' ||
    element.host_wall_guid !== undefined;

  if (isOpening) {
    const hostWall =
      element.hostWall ||
      (context?.elements ? context.elements[element.host_wall_guid] : null) ||
      (context?.[element.host_wall_guid]) ||
      (context?.start && context?.end ? context : null);

    if (hostWall && hostWall.start && hostWall.end) {
      const sx = Number(hostWall.start[0]);
      const sy = Number(hostWall.start[1]);
      const sz = Number(hostWall.start[2] ?? 0);
      const ex = Number(hostWall.end[0]);
      const ey = Number(hostWall.end[1]);
      const dx = ex - sx;
      const dy = ey - sy;
      const len = Math.hypot(dx, dy);
      if (len < 0.001) return [];
      const ux = dx / len;
      const uy = dy / len;
      const nx = -uy;
      const ny = ux;

      const offset = Number(element.offset_along_wall ?? 0.0);
      const cx = sx + ux * offset;
      const cy = sy + uy * offset;
      const sill = Number(element.sill_height ?? (element.ifc_class === 'IfcWindow' ? 3.0 : 0.0));
      const cz = sz + sill;
      const width = Number(element.width ?? (element.ifc_class === 'IfcDoor' ? 3.0 : 4.0));
      const height = Number(element.height ?? (element.ifc_class === 'IfcDoor' ? 7.0 : 4.0));
      const isFlipped = Boolean(element.swing_flipped);
      const isWindow = element.ifc_class === 'IfcWindow';
      const labelPrefix = isWindow ? 'Window' : 'Door';

      const openingGrips: Grip[] = [
        // Slide position (offset along wall)
        {
          id: `${guid}:offset`,
          elementGuid: guid,
          kind: 'opening_offset',
          worldPoint: [cx, cy, cz + height / 2],
          axis: [ux, uy, 0],
          value: offset,
          unit: 'ft',
          range: [0.0, len],
          label: `${labelPrefix} Position`,
          meta: { hostWallStart: hostWall.start, hostWallEnd: hostWall.end },
        },
        // Width adjustment
        {
          id: `${guid}:width`,
          elementGuid: guid,
          kind: 'opening_width',
          worldPoint: [cx + ux * (width / 2), cy + uy * (width / 2), cz + height / 2],
          axis: [ux, uy, 0],
          value: width,
          unit: 'ft',
          range: [0.5, 20.0],
          label: `${labelPrefix} Width`,
          meta: { hostWallStart: hostWall.start, hostWallEnd: hostWall.end },
        },
        // Flip orientation
        {
          id: `${guid}:flip`,
          elementGuid: guid,
          kind: 'opening_flip',
          worldPoint: [cx + nx * 0.75, cy + ny * 0.75, cz + height / 2],
          axis: [nx, ny, 0],
          value: isFlipped ? 1 : 0,
          unit: '',
          label: 'Flip Opening',
          meta: { hostWallStart: hostWall.start, hostWallEnd: hostWall.end },
        },
      ];

      // Window sill height grip
      if (isWindow || element.sill_height !== undefined) {
        openingGrips.push({
          id: `${guid}:sill_height`,
          elementGuid: guid,
          kind: 'opening_sill_height',
          worldPoint: [cx, cy, cz],
          axis: [0, 0, 1],
          value: sill,
          unit: 'ft',
          range: [0.0, 15.0],
          label: 'Window Sill Height',
          meta: { hostWallStart: hostWall.start, hostWallEnd: hostWall.end },
        });
      }

      return openingGrips;
    }
  }

  // 3. Slabs & Roofs (Polygon Vertices)
  const isPolygon =
    element.ifc_class === 'IfcSlab' ||
    element.ifc_class === 'IfcRoof' ||
    (Array.isArray(element.polygon) && element.polygon.length >= 3);

  if (isPolygon && Array.isArray(element.polygon)) {
    const elev = Number(element.elevation ?? 0.0);
    const labelPrefix = element.ifc_class === 'IfcRoof' ? 'Roof' : 'Slab';
    return element.polygon.map((pt: [number, number], idx: number) => ({
      id: `${guid}:vertex:${idx}`,
      elementGuid: guid,
      kind: 'polygon_vertex' as const,
      worldPoint: [Number(pt[0]), Number(pt[1]), elev] as [number, number, number],
      axis: [1, 0, 0] as [number, number, number],
      value: idx,
      unit: '',
      label: `${labelPrefix} Vertex ${idx + 1}`,
      meta: { vertexIndex: idx },
    }));
  }

  // 4. Levels
  const isLevel =
    element.ifc_class === 'IfcBuildingStorey' ||
    (element.elevation !== undefined && !element.polygon && !element.start);

  if (isLevel && element.elevation !== undefined) {
    const elev = Number(element.elevation);
    return [
      {
        id: `${guid}:elevation`,
        elementGuid: guid,
        kind: 'level_elevation',
        worldPoint: [0, 0, elev],
        axis: [0, 0, 1],
        value: elev,
        unit: 'ft',
        range: [-50.0, 500.0],
        label: `Level ${element.name || ''} Elevation`,
      },
    ];
  }

  // 5. Walls (Default)
  const isWall =
    element.ifc_class === 'IfcWall' ||
    element.ifc_class === 'IfcWallStandardCase' ||
    (element.start && element.end);

  if (!isWall) {
    return [];
  }

  const start = element.start || [0, 0, 0];
  const end = element.end || [0, 0, 0];
  const sx = Number(start[0]);
  const sy = Number(start[1]);
  const sz = Number(start[2] ?? 0);
  const ex = Number(end[0]);
  const ey = Number(end[1]);
  const ez = Number(end[2] ?? 0);

  const dx = ex - sx;
  const dy = ey - sy;
  const len = Math.hypot(dx, dy);
  if (len < 0.001) return [];

  const ux = dx / len;
  const uy = dy / len;
  const nx = -uy;
  const ny = ux;

  const height = Number(element.height ?? 10.0);
  const thickness = Number(element.thickness ?? 0.67);

  const mx = (sx + ex) / 2;
  const my = (sy + ey) / 2;
  const mz = (sz + ez) / 2;

  return [
    // 1. Wall Start Grip
    {
      id: `${element.guid}:start`,
      elementGuid: element.guid,
      kind: 'wall_start',
      worldPoint: [sx, sy, sz],
      axis: [-ux, -uy, 0],
      value: len,
      unit: 'ft',
      range: [0.5, 1000.0],
      ref: {
        guid: element.guid,
        ref: 'start',
        kind: 'wall_start',
        sources: [{ element_guid: element.guid, ref_type: 'start' }],
      },
      label: 'Wall Start',
    },
    // 2. Wall End Grip
    {
      id: `${element.guid}:end`,
      elementGuid: element.guid,
      kind: 'wall_end',
      worldPoint: [ex, ey, ez],
      axis: [ux, uy, 0],
      value: len,
      unit: 'ft',
      range: [0.5, 1000.0],
      ref: {
        guid: element.guid,
        ref: 'end',
        kind: 'wall_end',
        sources: [{ element_guid: element.guid, ref_type: 'end' }],
      },
      label: 'Wall End',
    },
    // 3. Wall Height Grip (top face center)
    {
      id: `${element.guid}:height`,
      elementGuid: element.guid,
      kind: 'wall_height',
      worldPoint: [mx, my, mz + height],
      axis: [0, 0, 1],
      value: height,
      unit: 'ft',
      range: [1.0, 100.0],
      label: 'Wall Height',
    },
    // 4. Wall Thickness Grip Positive (+normal side face center)
    {
      id: `${element.guid}:thickness:pos`,
      elementGuid: element.guid,
      kind: 'wall_thickness_pos',
      worldPoint: [mx + nx * (thickness / 2), my + ny * (thickness / 2), mz + height / 2],
      axis: [nx, ny, 0],
      value: thickness,
      unit: 'ft',
      range: [0.0833, 10.0],
      label: 'Wall Thickness (+)',
    },
    // 5. Wall Thickness Grip Negative (-normal side face center)
    {
      id: `${element.guid}:thickness:neg`,
      elementGuid: element.guid,
      kind: 'wall_thickness_neg',
      worldPoint: [mx - nx * (thickness / 2), my - ny * (thickness / 2), mz + height / 2],
      axis: [-nx, -ny, 0],
      value: thickness,
      unit: 'ft',
      range: [0.0833, 10.0],
      label: 'Wall Thickness (-)',
    },
  ];
}

/**
 * Computes the typed parameter edit command resulting from dragging a grip
 * to a target 3D world coordinate.
 */
export function computeGripDragCommand(
  grip: Grip,
  targetWorldPoint: [number, number, number],
  element: any,
  context?: any
): GripDragResult {
  const range = grip.range || [0.1, 1000.0];

  switch (grip.kind) {
    case 'wall_start': {
      const ep = element.end || [0, 0, 0];
      const targetX = targetWorldPoint[0];
      const targetY = targetWorldPoint[1];
      const dist = Math.hypot(ep[0] - targetX, ep[1] - targetY);
      const clampedDist = Math.max(range[0], dist);
      let finalPt: [number, number, number] = [targetX, targetY, grip.worldPoint[2]];
      if (dist < range[0] && dist > 0.0001) {
        const factor = range[0] / dist;
        finalPt = [ep[0] + (targetX - ep[0]) * factor, ep[1] + (targetY - ep[1]) * factor, grip.worldPoint[2]];
      }
      return {
        action: 'modifyWallEnd',
        command: 'WallSetEnd',
        params: {
          guid: grip.elementGuid,
          end: 'start',
          point: finalPt,
        },
        previewValue: clampedDist,
      };
    }

    case 'wall_end': {
      const sp = element.start || [0, 0, 0];
      const targetX = targetWorldPoint[0];
      const targetY = targetWorldPoint[1];
      const dist = Math.hypot(targetX - sp[0], targetY - sp[1]);
      const clampedDist = Math.max(range[0], dist);
      let finalPt: [number, number, number] = [targetX, targetY, grip.worldPoint[2]];
      if (dist < range[0] && dist > 0.0001) {
        const factor = range[0] / dist;
        finalPt = [sp[0] + (targetX - sp[0]) * factor, sp[1] + (targetY - sp[1]) * factor, grip.worldPoint[2]];
      }
      return {
        action: 'modifyWallEnd',
        command: 'WallSetEnd',
        params: {
          guid: grip.elementGuid,
          end: 'end',
          point: finalPt,
        },
        previewValue: clampedDist,
      };
    }

    case 'wall_height': {
      const baseZ = Number(element.start?.[2] ?? 0);
      const rawHeight = targetWorldPoint[2] - baseZ;
      const clampedHeight = Math.max(range[0], Math.min(range[1], rawHeight));
      return {
        action: 'modifyWallHeight',
        command: 'WallSetHeight',
        params: {
          guid: grip.elementGuid,
          height: Number(clampedHeight.toFixed(3)),
        },
        previewValue: clampedHeight,
      };
    }

    case 'wall_thickness_pos':
    case 'wall_thickness_neg': {
      const start = element.start || [0, 0, 0];
      const end = element.end || [0, 0, 0];
      const dx = end[0] - start[0];
      const dy = end[1] - start[1];
      const len = Math.hypot(dx, dy);
      if (len < 0.001) {
        return {
          action: 'modifyWallThickness',
          command: 'WallSetThickness',
          params: { guid: grip.elementGuid, thickness: grip.value },
          previewValue: grip.value,
        };
      }
      const nx = -dy / len;
      const ny = dx / len;
      const mx = (start[0] + end[0]) / 2;
      const my = (start[1] + end[1]) / 2;

      // Project target point offset from midpoint onto normal
      const offX = targetWorldPoint[0] - mx;
      const offY = targetWorldPoint[1] - my;
      const distFromBaseline = Math.abs(offX * nx + offY * ny);
      const rawThickness = distFromBaseline * 2;
      const clampedThickness = Math.max(range[0], Math.min(range[1], rawThickness));

      return {
        action: 'modifyWallThickness',
        command: 'WallSetThickness',
        params: {
          guid: grip.elementGuid,
          thickness: Number(clampedThickness.toFixed(3)),
        },
        previewValue: clampedThickness,
      };
    }

    case 'opening_offset': {
      const sp = grip.meta?.hostWallStart || [0, 0, 0];
      const ep = grip.meta?.hostWallEnd || [10, 0, 0];
      const dx = ep[0] - sp[0];
      const dy = ep[1] - sp[1];
      const len = Math.hypot(dx, dy);
      let rawOffset = 0;
      if (len > 0.001) {
        const ux = dx / len;
        const uy = dy / len;
        rawOffset = (targetWorldPoint[0] - sp[0]) * ux + (targetWorldPoint[1] - sp[1]) * uy;
      }
      const clampedOffset = Math.max(range[0], Math.min(range[1], rawOffset));
      return {
        action: 'modifyOpeningOffset',
        command: 'OpeningSetOffset',
        params: {
          guid: grip.elementGuid,
          offset: Number(clampedOffset.toFixed(3)),
        },
        previewValue: clampedOffset,
      };
    }

    case 'opening_width': {
      const sp = grip.meta?.hostWallStart || [0, 0, 0];
      const ep = grip.meta?.hostWallEnd || [10, 0, 0];
      const dx = ep[0] - sp[0];
      const dy = ep[1] - sp[1];
      const len = Math.hypot(dx, dy);
      let rawWidth = grip.value;
      if (len > 0.001) {
        const ux = dx / len;
        const uy = dy / len;
        const offset = Number(element.offset_along_wall ?? 0.0);
        const cx = sp[0] + ux * offset;
        const cy = sp[1] + uy * offset;
        const distFromCenter = Math.abs(
          (targetWorldPoint[0] - cx) * ux + (targetWorldPoint[1] - cy) * uy
        );
        rawWidth = distFromCenter * 2;
      }
      const clampedWidth = Math.max(range[0], Math.min(range[1], rawWidth));
      return {
        action: 'modifyOpeningWidth',
        command: 'OpeningSetWidth',
        params: {
          guid: grip.elementGuid,
          width: Number(clampedWidth.toFixed(3)),
        },
        previewValue: clampedWidth,
      };
    }

    case 'opening_sill_height': {
      const baseZ = Number(grip.meta?.hostWallStart?.[2] ?? 0.0);
      const rawHeight = targetWorldPoint[2] - baseZ;
      const clampedHeight = Math.max(range[0], Math.min(range[1], rawHeight));
      return {
        action: 'modifyOpeningSillHeight',
        command: 'OpeningSetSillHeight',
        params: {
          guid: grip.elementGuid,
          sill_height: Number(clampedHeight.toFixed(3)),
        },
        previewValue: clampedHeight,
      };
    }

    case 'opening_flip': {
      return {
        action: 'flipOpening',
        command: 'OpeningFlip',
        params: {
          guid: grip.elementGuid,
        },
        previewValue: grip.value ? 0 : 1,
      };
    }

    case 'grid_start':
    case 'grid_end': {
      const isStart = grip.kind === 'grid_start';
      const fixedPt = isStart ? element.end : element.start;
      const targetX = targetWorldPoint[0];
      const targetY = targetWorldPoint[1];
      const dist = fixedPt ? Math.hypot(targetX - fixedPt[0], targetY - fixedPt[1]) : 0;
      return {
        action: 'modifyGridEndpoint',
        command: 'GridSetEndpoint',
        params: {
          guid: grip.elementGuid,
          end: isStart ? 'start' : 'end',
          point: [Number(targetX.toFixed(3)), Number(targetY.toFixed(3))],
        },
        previewValue: dist,
      };
    }

    case 'polygon_vertex': {
      const vIdx = Number(grip.meta?.vertexIndex ?? grip.value);
      return {
        action: 'modifyPolygonVertex',
        command: 'PolygonSetVertex',
        params: {
          guid: grip.elementGuid,
          vertex_index: vIdx,
          point: [
            Number(targetWorldPoint[0].toFixed(3)),
            Number(targetWorldPoint[1].toFixed(3)),
          ],
        },
        previewValue: Math.hypot(targetWorldPoint[0], targetWorldPoint[1]),
      };
    }

    case 'level_elevation': {
      const clampedElevation = Math.max(range[0], Math.min(range[1], targetWorldPoint[2]));
      return {
        action: 'moveLevel',
        command: 'LevelMove',
        params: {
          level_id: grip.elementGuid,
          elevation: Number(clampedElevation.toFixed(3)),
        },
        previewValue: clampedElevation,
      };
    }
  }
}
