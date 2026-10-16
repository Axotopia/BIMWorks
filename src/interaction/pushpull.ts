/**
 * pushpull.ts — Face-based push/pull as a parameter gesture (Phase 7).
 *
 * IngeTrazo interaction model adapted to BIMWorks' parametric architecture:
 * - Hovering the top face of a wall (normal +Z) targets wall height.
 * - Hovering a side face of a wall (normal perpendicular to baseline) targets wall thickness.
 * - Dragging projects mouse motion along the face normal to compute the updated parameter.
 * - Validity rules & clamping (Phase 8) guard minimum thickness (>= 1 inch) and height (> 0).
 * - Routes parameter mutations through CommandBus typed commands (WallSetHeight, WallSetThickness).
 */

import * as THREE from 'three';

export interface WallFaceHit {
  guid: string;
  kind: 'top' | 'side';
  param: 'height' | 'thickness';
  label: string;
  normal: [number, number, number];
  hitPoint: [number, number, number];
  currentValue: number;
}

export interface PushPullCommandResult {
  action: 'modifyWallHeight' | 'modifyWallThickness';
  command: 'WallSetHeight' | 'WallSetThickness';
  params: {
    guid: string;
    height?: number;
    thickness?: number;
  };
  previewValue: number;
}

/**
 * Detects whether an intersection with a 3D mesh corresponds to a push/pull-able
 * wall face (top face -> height, side face -> thickness).
 */
export function detectWallFaceHover(
  hit: { object: any; point: THREE.Vector3; face?: { normal: THREE.Vector3 } | null },
  elements: Record<string, any>
): WallFaceHit | null {
  if (!hit || !hit.face || !hit.object) return null;
  const guid = hit.object.userData?.guid;
  if (!guid) return null;
  const element = elements[guid];
  if (!element) return null;

  const ifcClass = element.ifc_class || hit.object.userData?.ifc_class;
  if (ifcClass !== 'IfcWall' && ifcClass !== 'IfcWallStandardCase') return null;

  // Transform normal into world space
  const normal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld).normalize();

  // 1. Top face (normal pointing upward +Z > 0.7)
  if (normal.z > 0.7) {
    const height = Number(element.height ?? 10.0);
    return {
      guid,
      kind: 'top',
      param: 'height',
      label: 'Wall Height',
      normal: [normal.x, normal.y, normal.z],
      hitPoint: [hit.point.x, hit.point.y, hit.point.z],
      currentValue: height,
    };
  }

  // 2. Vertical side faces (|normal.z| <= 0.3)
  if (Math.abs(normal.z) <= 0.3) {
    const sp = element.start;
    const ep = element.end;
    if (sp && ep) {
      const dx = ep[0] - sp[0];
      const dy = ep[1] - sp[1];
      const len = Math.hypot(dx, dy);
      if (len > 0.001) {
        const tx = dx / len;
        const ty = dy / len;
        // Dot product of face normal with wall baseline tangent
        const dotTangent = Math.abs(normal.x * tx + normal.y * ty);
        // If normal is perpendicular to baseline (dotTangent <= 0.5), it's a side face!
        if (dotTangent <= 0.5) {
          const thickness = Number(element.thickness ?? 0.67);
          return {
            guid,
            kind: 'side',
            param: 'thickness',
            label: 'Wall Thickness',
            normal: [normal.x, normal.y, normal.z],
            hitPoint: [hit.point.x, hit.point.y, hit.point.z],
            currentValue: thickness,
          };
        }
      }
    }
  }

  return null;
}

/**
 * Computes the parameter update command resulting from a push/pull drag gesture.
 */
export function computePushPullCommand(
  face: WallFaceHit,
  targetWorldPoint: [number, number, number],
  element: any
): PushPullCommandResult {
  if (face.param === 'height') {
    const baseZ = Number(element.start?.[2] ?? 0.0);
    const rawHeight = targetWorldPoint[2] - baseZ;
    // Guarded by validity rules: minimum wall height 0.5 ft
    const clampedHeight = Math.max(0.5, rawHeight);
    const roundedHeight = Number(clampedHeight.toFixed(3));
    return {
      action: 'modifyWallHeight',
      command: 'WallSetHeight',
      params: {
        guid: face.guid,
        height: roundedHeight,
      },
      previewValue: roundedHeight,
    };
  } else {
    // Thickness push/pull
    const sp = element.start || [0, 0, 0];
    const ep = element.end || [0, 0, 0];
    const dx = ep[0] - sp[0];
    const dy = ep[1] - sp[1];
    const len = Math.hypot(dx, dy);
    let rawThickness = face.currentValue;
    if (len > 0.001) {
      const nx = -dy / len;
      const ny = dx / len;
      const mx = (sp[0] + ep[0]) / 2;
      const my = (sp[1] + ep[1]) / 2;
      const offX = targetWorldPoint[0] - mx;
      const offY = targetWorldPoint[1] - my;
      const distFromBaseline = Math.abs(offX * nx + offY * ny);
      rawThickness = distFromBaseline * 2;
    }
    // Guarded by validity rules: minimum wall thickness 1 inch (1.0 / 12.0 ft)
    const clampedThickness = Math.max(1.0 / 12.0, rawThickness);
    const roundedThickness = clampedThickness <= 1.0 / 12.0 + 1e-6
      ? 1.0 / 12.0
      : Number(clampedThickness.toFixed(4));
    return {
      action: 'modifyWallThickness',
      command: 'WallSetThickness',
      params: {
        guid: face.guid,
        thickness: roundedThickness,
      },
      previewValue: roundedThickness,
    };
  }
}
