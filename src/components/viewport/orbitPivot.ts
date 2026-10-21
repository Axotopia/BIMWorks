/**
 * Dynamic Surface Orbit Pivot for 3D Viewport
 * Adopted from N:\lapin\apps\viewer\src\components\viewer\useMouseControls.ts
 *
 * Sets the orbit pivot to the exact 3D point under the cursor when orbit begins.
 * On miss, anchors to the selected element center or retains current distance.
 * Seamlessly adjusts spherical coordinates so the camera never jumps.
 */

import * as THREE from 'three';

export interface DynamicPivotResult {
  newTarget: THREE.Vector3;
  newSpherical: { radius: number; theta: number; phi: number };
  hitSurface: boolean;
}

/**
 * Calculates a new orbit pivot anchored to the 3D surface under the cursor.
 * Updates target and spherical parameters while keeping the camera world position unchanged.
 */
export function computeOrbitPivot(
  camera: THREE.Camera,
  screenX: number,
  screenY: number,
  canvasWidth: number,
  canvasHeight: number,
  visibleMeshes: THREE.Mesh[],
  currentTarget: THREE.Vector3,
  selectedMeshes?: THREE.Mesh[]
): DynamicPivotResult {
  if (canvasWidth <= 0 || canvasHeight <= 0) {
    return {
      newTarget: currentTarget.clone(),
      newSpherical: computeSphericalFromTarget(camera.position, currentTarget),
      hitSurface: false,
    };
  }

  const ndcX = (screenX / canvasWidth) * 2 - 1;
  const ndcY = -(screenY / canvasHeight) * 2 + 1;

  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), camera);

  // 1. Raycast against visible meshes under cursor
  const hits = raycaster.intersectObjects(visibleMeshes, false);
  let pivotPoint: THREE.Vector3 | null = null;

  if (hits.length > 0) {
    pivotPoint = hits[0].point;
  } else if (selectedMeshes && selectedMeshes.length > 0) {
    // 2. Fall back to centroid of selected geometry
    const box = new THREE.Box3();
    selectedMeshes.forEach((mesh) => box.expandByObject(mesh));
    if (!box.isEmpty()) {
      pivotPoint = box.getCenter(new THREE.Vector3());
    }
  }

  // 3. Fall back to current target if no hit and no selection
  const newTarget = pivotPoint ? pivotPoint.clone() : currentTarget.clone();
  const newSpherical = computeSphericalFromTarget(camera.position, newTarget);

  return {
    newTarget,
    newSpherical,
    hitSurface: Boolean(pivotPoint),
  };
}

/**
 * Derives spherical coordinates (radius, theta, phi) from camera position relative to target,
 * matching BIMWorks' Z-up coordinate system:
 * x = target.x + r * sin(phi) * sin(theta)
 * y = target.y + r * sin(phi) * cos(theta)
 * z = target.z + r * cos(phi)
 */
export function computeSphericalFromTarget(
  cameraPos: THREE.Vector3,
  target: THREE.Vector3
): { radius: number; theta: number; phi: number } {
  const relX = cameraPos.x - target.x;
  const relY = cameraPos.y - target.y;
  const relZ = cameraPos.z - target.z;

  const radius = Math.max(0.5, Math.hypot(relX, relY, relZ));
  const phi = Math.acos(Math.max(-1, Math.min(1, relZ / radius)));
  const theta = Math.atan2(relX, relY);

  return { radius, theta, phi };
}
