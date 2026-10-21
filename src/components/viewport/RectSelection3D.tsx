/**
 * 3D Window vs. Crossing Marquee Selection Overlay & Hit Evaluator
 * Adopted from N:\lapin\apps\viewer\src\components\viewer\RectSelectionOverlay.tsx
 *
 * Implements CAD-standard marquee selection:
 * - Drag Left-to-Right: Window Selection (solid blue border, selects elements fully enclosed)
 * - Drag Right-to-Left: Crossing Selection (dashed green border, selects elements intersecting)
 */

import React from 'react';
import * as THREE from 'three';
import { isBoxInside, isBoxCrossing, BoundingBox2D } from '../../interaction/snapEngine';

export interface MarqueeRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface RectSelection3DProps {
  rect: MarqueeRect | null;
}

export const RectSelection3D: React.FC<RectSelection3DProps> = ({ rect }) => {
  if (!rect) return null;

  const left = Math.min(rect.x0, rect.x1);
  const top = Math.min(rect.y0, rect.y1);
  const width = Math.abs(rect.x1 - rect.x0);
  const height = Math.abs(rect.y1 - rect.y0);

  if (width < 3 && height < 3) return null;

  // Dragging right-to-left is Crossing selection; left-to-right is Window selection
  const isCrossing = rect.x1 < rect.x0;

  return (
    <div
      className={`absolute pointer-events-none transition-none z-30 ${
        isCrossing
          ? 'border-2 border-dashed border-emerald-400 bg-emerald-500/15'
          : 'border-2 border-solid border-sky-400 bg-sky-500/15'
      }`}
      style={{
        left: `${left}px`,
        top: `${top}px`,
        width: `${width}px`,
        height: `${height}px`,
      }}
    >
      <div
        className={`absolute bottom-1 right-1 text-[10px] font-mono px-1 py-0.5 rounded shadow ${
          isCrossing
            ? 'bg-emerald-950/80 text-emerald-300 border border-emerald-600/60'
            : 'bg-sky-950/80 text-sky-300 border border-sky-600/60'
        }`}
      >
        {isCrossing ? 'Crossing' : 'Window'}
      </div>
    </div>
  );
};

/**
 * Evaluates which 3D meshes fall within or cross the marquee rectangle.
 */
export function evaluate3DMarqueeSelection(
  rect: MarqueeRect,
  camera: THREE.Camera,
  meshesMap: Map<string, THREE.Mesh>,
  viewportWidth: number,
  viewportHeight: number
): string[] {
  if (viewportWidth <= 0 || viewportHeight <= 0) return [];

  const left = Math.min(rect.x0, rect.x1);
  const top = Math.min(rect.y0, rect.y1);
  const right = Math.max(rect.x0, rect.x1);
  const bottom = Math.max(rect.y0, rect.y1);

  if (Math.abs(right - left) < 4 && Math.abs(bottom - top) < 4) {
    return [];
  }

  const isCrossing = rect.x1 < rect.x0;
  const selBox: BoundingBox2D = {
    minX: left,
    minY: top,
    maxX: right,
    maxY: bottom,
  };

  const selectedGuids: string[] = [];

  meshesMap.forEach((mesh, guid) => {
    if (!mesh.visible || !mesh.geometry) return;

    if (!mesh.geometry.boundingBox) {
      mesh.geometry.computeBoundingBox();
    }
    const geomBox = mesh.geometry.boundingBox;
    if (!geomBox) return;

    const box3 = geomBox.clone().applyMatrix4(mesh.matrixWorld);

    // Project 8 corners of the 3D bounding box to 2D screen coordinates
    const corners = [
      new THREE.Vector3(box3.min.x, box3.min.y, box3.min.z),
      new THREE.Vector3(box3.min.x, box3.min.y, box3.max.z),
      new THREE.Vector3(box3.min.x, box3.max.y, box3.min.z),
      new THREE.Vector3(box3.min.x, box3.max.y, box3.max.z),
      new THREE.Vector3(box3.max.x, box3.min.y, box3.min.z),
      new THREE.Vector3(box3.max.x, box3.min.y, box3.max.z),
      new THREE.Vector3(box3.max.x, box3.max.y, box3.min.z),
      new THREE.Vector3(box3.max.x, box3.max.y, box3.max.z),
    ];

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    let hasVisibleCorner = false;

    for (const corner of corners) {
      const projected = corner.clone().project(camera);

      // Frustum check: corner must be in front of near plane (-1 to 1 in Z)
      if (projected.z > 1.0) continue;
      hasVisibleCorner = true;

      const sx = ((projected.x + 1) / 2) * viewportWidth;
      const sy = ((-projected.y + 1) / 2) * viewportHeight;

      if (sx < minX) minX = sx;
      if (sy < minY) minY = sy;
      if (sx > maxX) maxX = sx;
      if (sy > maxY) maxY = sy;
    }

    if (!hasVisibleCorner || minX === Infinity) return;

    const targetBox: BoundingBox2D = { minX, minY, maxX, maxY };

    const matches = isCrossing
      ? isBoxCrossing(targetBox, selBox)
      : isBoxInside(targetBox, selBox);

    if (matches) {
      selectedGuids.push(guid);
    }
  });

  return selectedGuids;
}
