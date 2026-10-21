/**
 * Cursor-Anchored Surface Zoom for 3D Viewport
 * Adopted from N:\lapin\apps\viewer\src\components\viewer\zoomSurface.ts
 *
 * Allows zooming into the geometry directly under the cursor ray.
 */

import * as THREE from 'three';

export interface SurfaceAnchorResult {
  newTarget: THREE.Vector3;
  hitPoint: THREE.Vector3 | null;
}

/**
 * Computes an adjusted orbit target shifted toward the surface under the cursor.
 * When zooming in, gently nudges the target towards the hit point to keep the
 * feature under the mouse stable on screen.
 */
export function anchorTargetToCursorRay(
  camera: THREE.Camera,
  screenX: number,
  screenY: number,
  canvasWidth: number,
  canvasHeight: number,
  visibleMeshes: THREE.Mesh[],
  currentTarget: THREE.Vector3,
  isZoomIn: boolean
): SurfaceAnchorResult {
  if (canvasWidth <= 0 || canvasHeight <= 0 || !isZoomIn) {
    return { newTarget: currentTarget.clone(), hitPoint: null };
  }

  const ndcX = (screenX / canvasWidth) * 2 - 1;
  const ndcY = -(screenY / canvasHeight) * 2 + 1;

  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), camera);

  const hits = raycaster.intersectObjects(visibleMeshes, false);
  if (hits.length === 0) {
    return { newTarget: currentTarget.clone(), hitPoint: null };
  }

  const hitPoint = hits[0].point;
  // Shift target 12% towards the hit point on each notch to avoid jarring jumps
  const lerpFactor = 0.12;
  const newTarget = currentTarget.clone().lerp(hitPoint, lerpFactor);

  return { newTarget, hitPoint };
}
