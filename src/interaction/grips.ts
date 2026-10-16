/**
 * Direct Manipulation — Grips Layer for Architectural Elements.
 *
 * Implements per-element grips that emit typed parameter commands rather
 * than raw geometry modifications.
 *
 * Wall grips:
 * - 2 End grips (baseline start & end points)
 * - 1 Height grip (top face center)
 * - 2 Thickness grips (positive & negative normal side face centers)
 */

export type GripKind =
  | 'wall_start'
  | 'wall_end'
  | 'wall_height'
  | 'wall_thickness_pos'
  | 'wall_thickness_neg';

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
}

export interface GripDragResult {
  action: 'modifyWallHeight' | 'modifyWallThickness' | 'modifyWallEnd';
  command: 'WallSetHeight' | 'WallSetThickness' | 'WallSetEnd';
  params: Record<string, any>;
  previewValue: number;
}

/**
 * Returns all active direct-manipulation grips for an element.
 */
export function gripsFor(element: any): Grip[] {
  if (!element || !element.guid) return [];

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

  const grips: Grip[] = [
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

  return grips;
}

/**
 * Computes the typed parameter edit command resulting from dragging a grip
 * to a target 3D world coordinate.
 */
export function computeGripDragCommand(
  grip: Grip,
  targetWorldPoint: [number, number, number],
  element: any
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
  }
}
