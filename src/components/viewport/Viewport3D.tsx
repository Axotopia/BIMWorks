import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import * as THREE from 'three';
import { useBimStore, ZOOM_EXTENTS_EVENT } from '../../store/useBimStore';
import { formatLength, tryParseLength } from '../../utils/units';
import { Scissors, Maximize, RotateCw, Move, Lock } from 'lucide-react';
import { ContextMenu } from '../common/ContextMenu';
import { findSnapCandidate, SnapSegment, SnapCandidate } from '../../interaction/snapEngine';
import { gripsFor, computeGripDragCommand, Grip } from '../../interaction/grips';
import { ValueControlBox } from './ValueControlBox';

/**
 * UI-P0-13: pointer capture over a React synthetic mouse event.
 *
 * The handlers stay `onMouse*` because three.js raycasting is driven from
 * `clientX`/`clientY` and nothing here needs pressure or pointer type. Pointer
 * capture is still the only way to be told about a button release that happens
 * outside the viewport, and the native event underneath carries the pointer id
 * that the synthetic event does not expose.
 */
type CaptureTarget = HTMLElement & {
  setPointerCapture?: (id: number) => void;
  releasePointerCapture?: (id: number) => void;
  hasPointerCapture?: (id: number) => boolean;
};

function pointerIdOf(e: React.MouseEvent): number {
  const native = e.nativeEvent as MouseEvent & { pointerId?: number };
  return typeof native.pointerId === 'number' ? native.pointerId : 1;
}

/**
 * UI-P0-12: release the GPU buffers a three.js object owns.
 *
 * The mesh effect tears down and rebuilds every element's geometry, edge lines and
 * materials whenever the model, selection, hover, visibility or visual style
 * changes — so a single wall edit reallocated the whole model on the GPU. Nothing
 * was ever disposed (the only `dispose()` in the file was `renderer.dispose()` on
 * unmount), a steady leak that shows up as the app getting heavier the longer a
 * session runs and eventually as a lost WebGL context.
 *
 * `shared` geometries/materials are skipped because three.js refcounts nothing:
 * disposing something another mesh still uses would blank that mesh.
 */
function disposeObject(object: THREE.Object3D): void {
  const maybeDispose = (resource: unknown) => {
    const disposable = resource as { dispose?: () => void; userData?: { shared?: boolean } } | undefined;
    if (disposable && typeof disposable.dispose === 'function' && !disposable.userData?.shared) {
      disposable.dispose();
    }
  };
  object.traverse((child) => {
    const mesh = child as THREE.Mesh | THREE.LineSegments;
    maybeDispose(mesh.geometry);
    const material = (mesh as THREE.Mesh).material;
    if (Array.isArray(material)) material.forEach(maybeDispose);
    else maybeDispose(material);
  });
}

/**
 * Both wall classes the engine emits. The door/window host filter used to accept
 * only `IfcWallStandardCase`, so a click on an `IfcWall` did nothing at all.
 */
const HOSTABLE_WALL_CLASSES = ['IfcWallStandardCase', 'IfcWall'];

/**
 * UI-P0-15: the distance along a wall's baseline, from its start point, of the
 * point the user actually clicked.
 *
 * The old 3D behaviour was `Math.max(0.8, Math.hypot(hit.point.x, hit.point.y) *
 * 0.4)` — a function of the hit point's distance from the *world origin*, clamped
 * to a 0.8 ft minimum. It was unrelated to the wall's start, its length, or where
 * the ray struck, so a door landed in an arbitrary place that changed if the model
 * moved. This projects onto the real baseline instead, which is what the 2D
 * viewport already did correctly.
 */
function offsetAlongBaseline(
  host: { start?: [number, number, number]; end?: [number, number, number]; length?: number } | undefined,
  point: THREE.Vector3
): number {
  if (!host?.start || !host?.end) return 0;
  const [sx, sy] = host.start;
  const [ex, ey] = host.end;
  const length = Math.hypot(ex - sx, ey - sy);
  if (length < 1e-6) return 0;
  const ux = (ex - sx) / length;
  const uy = (ey - sy) / length;
  const projected = (point.x - sx) * ux + (point.y - sy) * uy;
  // Keep the element on its host rather than hanging off an end.
  return Math.max(0, Math.min(length, projected));
}

export const Viewport3D: React.FC = () => {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  /** Set while a placement mousedown is completing, so the click that follows the
   *  same gesture does not also re-select the host. */
  const placementGuidRef = useRef<string | null>(null);

  const {
    meshes,
    elements,
    grids,
    levels,
    selectedGuid,
    selectedGuids,
    setSelectedGuid,
    hoveredGuid,
    setHoveredGuid,
    activeTool,
    setActiveTool,
    createWall,
    createRoof,
    createSlab,
    createDoor,
    createWindow,
    sectionBox,
    setSectionBoxBounds,
    hiddenGuids,
    isolatedGuids,
    tempDimension,
    applyTemporaryDimensionChange,
    activeVisualStyle,
    alignPickState,
    setAlignPickState,
    createAlignConstraint,
    projectName,
    sketchSession,
    startSketchMode,
    cancelSketchMode,
    finishSketchMode,
    interactionResetToken,
    setStatusMessage,
    displayUnit,
    interactionSession,
    dispatchInteraction,
    beginDrag,
    endDrag,
    modifyWallHeight,
    modifyWallThickness,
    modifyWallEnd,
  } = useBimStore();

  // Internal Three.js state
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  // Set when WebGL is unavailable, so the panel can explain itself instead of taking
  // the whole application down with it.
  const [webglError, setWebglError] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; guid: string | null } | null>(null);
  const threeMeshesRef = useRef<Map<string, THREE.Mesh>>(new Map());
  const clippingPlanesRef = useRef<THREE.Plane[]>([]);
  const sectionBoxMeshRef = useRef<THREE.LineSegments | null>(null);

  // Orbit & Pan mouse navigation state (Revit Shift+MMB orbit, MMB pan)
  const isNavigatingRef = useRef<{ mode: 'orbit' | 'pan' | null; startX: number; startY: number }>({
    mode: null,
    startX: 0,
    startY: 0,
  });

  // Wall placement interaction
  const [wallStartPoint, setWallStartPoint] = useState<[number, number, number] | null>(null);
  const [wallCurrentPoint, setWallCurrentPoint] = useState<[number, number, number] | null>(null);

  // Box footprint interaction (Roof / Slab)
  const [boxStartPoint, setBoxStartPoint] = useState<[number, number] | null>(null);
  const [boxCurrentPoint, setBoxCurrentPoint] = useState<[number, number] | null>(null);

  const [editingDimValue, setEditingDimValue] = useState<string>('');
  const [cameraTick, setCameraTick] = useState(0);
  const [hoveredGripId, setHoveredGripId] = useState<string | null>(null);
  const [activeSnapCandidate, setActiveSnapCandidate] = useState<SnapCandidate | null>(null);
  const activeDragGripRef = useRef<{ grip: Grip; element: any } | null>(null);
  const [liveGripValue, setLiveGripValue] = useState<{ label: string; value: number } | null>(null);
  const [isEditingDim, setIsEditingDim] = useState<boolean>(false);

  const handleCommitLiveValue = useCallback((feet: number) => {
    if (activeTool === 'WA' && wallStartPoint && wallCurrentPoint) {
      const dx = wallCurrentPoint[0] - wallStartPoint[0];
      const dy = wallCurrentPoint[1] - wallStartPoint[1];
      const len = Math.hypot(dx, dy);
      const dir = len > 0.001 ? [dx / len, dy / len] : [1, 0];
      const endPt: [number, number, number] = [
        wallStartPoint[0] + dir[0] * feet,
        wallStartPoint[1] + dir[1] * feet,
        wallStartPoint[2],
      ];
      createWall(wallStartPoint, endPt);
      setWallStartPoint(null);
      setWallCurrentPoint(null);
      setActiveTool('select');
      setLiveGripValue(null);
    } else if (activeDragGripRef.current) {
      const { grip, element } = activeDragGripRef.current;
      if (grip.kind === 'wall_height') {
        modifyWallHeight(element.guid, feet);
      } else if (grip.kind === 'wall_thickness_pos' || grip.kind === 'wall_thickness_neg') {
        modifyWallThickness(element.guid, feet);
      } else if (grip.kind === 'wall_start' || grip.kind === 'wall_end') {
        const isStart = grip.kind === 'wall_start';
        const fixedPt = isStart ? element.end : element.start;
        const movingPt = isStart ? element.start : element.end;
        if (fixedPt && movingPt) {
          const dx = movingPt[0] - fixedPt[0];
          const dy = movingPt[1] - fixedPt[1];
          const curLen = Math.hypot(dx, dy);
          if (curLen > 0.001) {
            const ratio = feet / curLen;
            const newPt: [number, number, number] = [
              fixedPt[0] + dx * ratio,
              fixedPt[1] + dy * ratio,
              movingPt[2] ?? 0,
            ];
            modifyWallEnd(element.guid, isStart ? 'start' : 'end', newPt);
          }
        }
      }
      endDrag(true);
      activeDragGripRef.current = null;
      setLiveGripValue(null);
    }
  }, [activeTool, wallStartPoint, wallCurrentPoint, createWall, setActiveTool, modifyWallHeight, modifyWallThickness, modifyWallEnd, endDrag]);

  const snapSegments = useMemo<SnapSegment[]>(() => {
    const segs: SnapSegment[] = [];
    for (const elem of Object.values(elements)) {
      if (elem.start && elem.end && elem.ifc_class?.includes('Wall')) {
        segs.push({
          p1: [elem.start[0], elem.start[1]],
          p2: [elem.end[0], elem.end[1]],
          guid: elem.guid,
        });
      }
    }
    for (const g of grids) {
      if (g.start && g.end) {
        segs.push({
          p1: [g.start[0], g.start[1]],
          p2: [g.end[0], g.end[1]],
          guid: g.guid,
        });
      }
    }
    return segs;
  }, [elements, grids]);

  const getSnappedPoint3D = useCallback(
    (rawX: number, rawY: number, activePt?: [number, number] | null, forceOrtho = false): [number, number] => {
      if (!cameraRef.current || !containerRef.current) {
        return [rawX, rawY];
      }
      const rect = containerRef.current.getBoundingClientRect();
      const p1 = new THREE.Vector3(rawX, rawY, 0).project(cameraRef.current);
      const p2 = new THREE.Vector3(rawX + 1, rawY, 0).project(cameraRef.current);
      const screenDist = Math.hypot(
        ((p2.x - p1.x) * rect.width) / 2,
        ((p2.y - p1.y) * rect.height) / 2
      );
      const scale3D = Math.max(5, screenDist);

      const snap = findSnapCandidate([rawX, rawY], {
        scale: scale3D,
        pixelTolerance: 14,
        activePoint: activePt,
        segments: snapSegments,
        enableGridSnap: true,
        gridSize: 0.5,
        forceOrtho,
      });

      setActiveSnapCandidate(snap);
      return snap ? snap.point : [rawX, rawY];
    },
    [snapSegments]
  );

  /**
   * UI-P0-10/UI-P0-11: discard every piece of in-progress interaction state.
   *
   * These live in the component, so the store cannot clear them itself; the store
   * bumps `interactionResetToken` instead and this effect responds. It runs for
   * Escape, for a tool change and at the end of a sketch — one cancel path rather
   * than the two Escape listeners that used to disagree.
   *
   * This matters beyond tidiness: pressing WA, clicking once, pressing Escape and
   * then clicking again used to complete a wall from the *pre-Escape* first point,
   * producing geometry the user had explicitly cancelled. Switching RF→SB reused
   * one shared box slot, so the floor inherited the roof's first corner.
   */
  useEffect(() => {
    setWallStartPoint(null);
    setWallCurrentPoint(null);
    setBoxStartPoint(null);
    setBoxCurrentPoint(null);
    setIsEditingDim(false);
    setEditingDimValue('');
    setActiveSnapCandidate(null);
    isNavigatingRef.current.mode = null;
    // `activeTool` is a belt-and-braces dependency: `setActiveTool` also bumps the
    // token, but a tool armed by any route must clear a half-finished pick.
  }, [interactionResetToken, activeTool]);

  // UI-P0-12: a closed dimension editor must not survive its dimension.
  useEffect(() => {
    if (!tempDimension) {
      setIsEditingDim(false);
      setEditingDimValue('');
    }
  }, [tempDimension]);

  // Camera targets & orbit angles (Z-up coordinate system)
  const targetRef = useRef<THREE.Vector3>(new THREE.Vector3(6, 4.5, 1.5));
  const sphericalRef = useRef<{ radius: number; theta: number; phi: number }>({
    radius: 20,
    theta: Math.PI / 4,
    phi: Math.PI / 3,
  });

  const updateCameraPosition = useCallback(() => {
    if (!cameraRef.current) return;
    const { radius, theta, phi } = sphericalRef.current;
    const target = targetRef.current;

    // Z-up spherical coordinates
    const x = target.x + radius * Math.sin(phi) * Math.sin(theta);
    const y = target.y + radius * Math.sin(phi) * Math.cos(theta);
    const z = target.z + radius * Math.cos(phi);

    cameraRef.current.position.set(x, y, z);
    cameraRef.current.lookAt(target);
    setCameraTick((t) => (t + 1) % 1000000);
  }, []);

  // Initialize Three.js WebGL2 scene
  useEffect(() => {
    if (!containerRef.current || !canvasRef.current) return;

    // Architectural Z-up convention
    THREE.Object3D.DEFAULT_UP.set(0, 0, 1);

    const width = containerRef.current.clientWidth;
    const height = containerRef.current.clientHeight;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x202022); // Consistent shaded Revit background
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 1000);
    camera.up.set(0, 0, 1);
    cameraRef.current = camera;
    updateCameraPosition();

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        canvas: canvasRef.current,
        antialias: true,
        stencil: true, // For real-time section box solid capping
      });
    } catch (e) {
      // A machine without a usable WebGL context (no GPU, headless, remote session,
      // blocklisted driver) throws here. Reporting it keeps the 2D plan, browser and
      // properties panels usable; throwing blanked the entire application before.
      const detail = e instanceof Error ? e.message : String(e);
      console.error('WebGL unavailable:', detail);
      setWebglError(detail);
      return;
    }
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.localClippingEnabled = true;
    rendererRef.current = renderer;

    // Lights for Revit Consistent Colors style
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.85);
    scene.add(ambientLight);

    const dirLight1 = new THREE.DirectionalLight(0xffffff, 0.4);
    dirLight1.position.set(30, 20, 50);
    scene.add(dirLight1);

    const dirLight2 = new THREE.DirectionalLight(0xffffff, 0.25);
    dirLight2.position.set(-20, -30, 20);
    scene.add(dirLight2);

    // Architectural Ground Grid at Z=0
    const gridHelper = new THREE.GridHelper(50, 50, 0x444444, 0x2d2d2d);
    gridHelper.rotation.x = Math.PI / 2; // Lie flat in XY plane
    scene.add(gridHelper);

    // UI-P0-13: a wheel listener registered natively with `passive: false`.
    // React attaches `wheel` passively at the root container, so the
    // `e.preventDefault()` both viewports called could not reliably stop the page
    // from scrolling behind the app while the camera zoomed. Capturing here and
    // stopping propagation is what actually keeps the gesture inside the viewport.
    const handleNativeWheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const zoomFactor = event.deltaY > 0 ? 1.15 : 0.85;
      sphericalRef.current.radius = Math.max(
        0.5,
        Math.min(10000, sphericalRef.current.radius * zoomFactor)
      );
      updateCameraPosition();
    };
    const wheelTarget = canvasRef.current;
    wheelTarget?.addEventListener('wheel', handleNativeWheel, { passive: false });

    // Render loop
    let animationFrameId: number;
    const animate = () => {
      animationFrameId = requestAnimationFrame(animate);
      renderer.render(scene, camera);
    };
    animate();

    // Resize handler
    const handleResize = () => {
      if (!containerRef.current || !rendererRef.current || !cameraRef.current) return;
      const w = containerRef.current.clientWidth;
      const h = containerRef.current.clientHeight;
      if (w === 0 || h === 0) return;
      cameraRef.current.aspect = w / h;
      cameraRef.current.updateProjectionMatrix();
      rendererRef.current.setSize(w, h);
    };
    window.addEventListener('resize', handleResize);

    const resizeObserver = new ResizeObserver(() => {
      handleResize();
    });
    if (containerRef.current) {
      resizeObserver.observe(containerRef.current);
    }

    return () => {
      cancelAnimationFrame(animationFrameId);
      window.removeEventListener('resize', handleResize);
      wheelTarget?.removeEventListener('wheel', handleNativeWheel);
      resizeObserver.disconnect();
      // UI-P0-12: release the scene's own resources too, not just the renderer.
      // The section-box wireframe previously outlived the viewport entirely.
      if (sectionBoxMeshRef.current) {
        disposeObject(sectionBoxMeshRef.current);
        sectionBoxMeshRef.current = null;
      }
      gridHelper.geometry.dispose();
      if (Array.isArray(gridHelper.material)) gridHelper.material.forEach((m) => m.dispose());
      else gridHelper.material?.dispose();
      renderer.dispose();
    };
  }, [updateCameraPosition]);

  // Update Section Box clipping planes
  useEffect(() => {
    if (!sceneRef.current || !rendererRef.current) return;

    if (sectionBox.enabled) {
      const { min, max } = sectionBox;
      // 6 clipping planes for AABB
      const planes = [
        new THREE.Plane(new THREE.Vector3(1, 0, 0), -min[0]),
        new THREE.Plane(new THREE.Vector3(-1, 0, 0), max[0]),
        new THREE.Plane(new THREE.Vector3(0, 1, 0), -min[1]),
        new THREE.Plane(new THREE.Vector3(0, -1, 0), max[1]),
        new THREE.Plane(new THREE.Vector3(0, 0, 1), -min[2]),
        new THREE.Plane(new THREE.Vector3(0, 0, -1), max[2]),
      ];
      clippingPlanesRef.current = planes;
      rendererRef.current.clippingPlanes = planes;

      // Draw wireframe Section Box bounding box
      if (sectionBoxMeshRef.current) {
        // UI-P0-12: disposing the previous wireframe's geometry/material, not just
        // detaching it, was missing here and in every other replacement path.
        disposeObject(sectionBoxMeshRef.current);
        sceneRef.current.remove(sectionBoxMeshRef.current);
      }
      const boxGeom = new THREE.BoxGeometry(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
      const edges = new THREE.EdgesGeometry(boxGeom);
      // The BoxGeometry only exists to derive the wireframe edges.
      boxGeom.dispose();
      const line = new THREE.LineSegments(
        edges,
        new THREE.LineBasicMaterial({ color: 0x38bdf8, linewidth: 2 })
      );
      line.position.set(
        (min[0] + max[0]) / 2,
        (min[1] + max[1]) / 2,
        (min[2] + max[2]) / 2
      );
      sceneRef.current.add(line);
      sectionBoxMeshRef.current = line;
    } else {
      clippingPlanesRef.current = [];
      rendererRef.current.clippingPlanes = [];
      if (sectionBoxMeshRef.current && sceneRef.current) {
        disposeObject(sectionBoxMeshRef.current);
        sceneRef.current.remove(sectionBoxMeshRef.current);
        sectionBoxMeshRef.current = null;
      }
    }
  }, [sectionBox]);

  // Populate IFC Elements Meshes in Three.js Scene
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;

    // Clear previous elements. UI-P0-12: dispose, do not merely detach — this runs
    // on every model/selection/hover/style change.
    threeMeshesRef.current.forEach((mesh) => {
      scene.remove(mesh);
      disposeObject(mesh);
    });
    threeMeshesRef.current.clear();

    meshes.forEach((mData) => {
      // Check visibility filter
      if (hiddenGuids.includes(mData.guid)) return;
      if (isolatedGuids.length > 0 && !isolatedGuids.includes(mData.guid)) return;

      // In Revit Sketch Mode: Hide the target element being edited
      if (sketchSession?.isEditingExisting && sketchSession.targetGuid === mData.guid) {
        return;
      }

      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.Float32BufferAttribute(mData.vertices, 3));
      geom.setIndex(mData.indices);
      geom.computeVertexNormals();

      const isSelected = selectedGuid === mData.guid;
      const isHovered = hoveredGuid === mData.guid;

      let color = mData.color;
      let opacity = mData.opacity;

      // In Revit Sketch Mode: Dim all other model elements (halftone)
      const isHalftone = !!sketchSession;
      if (isHalftone) {
        opacity = Math.min(opacity, 0.22);
      }

      if (isSelected) {
        color = '#0284c7'; // Revit selection blue
      } else if (isHovered) {
        color = '#38bdf8';
      }

      // Material based on visual style
      let mat: THREE.Material;
      if (activeVisualStyle === 'wireframe') {
        mat = new THREE.MeshBasicMaterial({
          color: isSelected ? 0x0284c7 : 0xd4d4d4,
          wireframe: true,
          clippingPlanes: clippingPlanesRef.current,
          transparent: isHalftone,
          opacity: isHalftone ? 0.25 : 1.0,
        });
      } else if (activeVisualStyle === 'hidden_line') {
        mat = new THREE.MeshLambertMaterial({
          color: isSelected ? 0x0284c7 : 0xffffff,
          clippingPlanes: clippingPlanesRef.current,
          transparent: isHalftone,
          opacity: isHalftone ? 0.25 : 1.0,
        });
      } else {
        // Consistent colors (Revit default)
        mat = new THREE.MeshStandardMaterial({
          color: new THREE.Color(color),
          roughness: 0.8,
          metalness: 0.1,
          transparent: isHalftone || opacity < 1.0,
          opacity: opacity,
          clippingPlanes: clippingPlanesRef.current,
          clipShadows: true,
        });
      }

      const mesh = new THREE.Mesh(geom, mat);
      mesh.userData = { guid: mData.guid, name: mData.name, ifc_class: mData.ifc_class };

      // Edges overlay for sharp architectural linework
      const edges = new THREE.EdgesGeometry(geom, 24);
      const edgeLine = new THREE.LineSegments(
        edges,
        new THREE.LineBasicMaterial({
          color: isSelected ? 0x0369a1 : 0x1e293b,
          clippingPlanes: clippingPlanesRef.current,
          transparent: isHalftone,
          opacity: isHalftone ? 0.2 : 1.0,
        })
      );
      mesh.add(edgeLine);

      scene.add(mesh);
      threeMeshesRef.current.set(mData.guid, mesh);
    });
  }, [meshes, selectedGuid, hoveredGuid, hiddenGuids, isolatedGuids, activeVisualStyle, sketchSession]);

  // Handle Revit Navigation Events:
  // - Shift + MMB: Orbit
  // - MMB: Pan
  // - Wheel: Zoom
  // - Z+E: Zoom Extents
  const handleMouseDown = (e: React.MouseEvent) => {
    // UI-P0-13: capture the pointer so a drag that leaves the viewport still ends
    // here. Mouse-up used to be bound to this div only, with no capture and no
    // mouse-leave, so releasing the button outside the canvas left the navigation
    // mode latched and the model panned/orbited on every subsequent bare move.
    const target = e.currentTarget as CaptureTarget;
    target.setPointerCapture?.(pointerIdOf(e));

    // Determine navigation mode
    if (e.button === 1) {
      // Middle Mouse Button
      e.preventDefault();
      if (e.shiftKey) {
        isNavigatingRef.current = { mode: 'orbit', startX: e.clientX, startY: e.clientY };
      } else {
        isNavigatingRef.current = { mode: 'pan', startX: e.clientX, startY: e.clientY };
      }
      return;
    }

    // Left Mouse Button: Selection or Drawing Tool
    if (e.button === 0) {
      dispatchInteraction({ type: 'pointer_down', screenPoint: [e.clientX, e.clientY] });
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect || !cameraRef.current || !sceneRef.current) return;

      const mouse = new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1
      );

      const raycaster = new THREE.Raycaster();
      raycaster.setFromCamera(mouse, cameraRef.current);

      // Tool: Wall Creation (WA)
      if (activeTool === 'WA') {
        const groundPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
        const intersectPt = new THREE.Vector3();
        raycaster.ray.intersectPlane(groundPlane, intersectPt);

        const start = (interactionSession.picks[0] as [number, number, number] | undefined) ?? wallStartPoint;
        if (!start) {
          const [x, y] = getSnappedPoint3D(intersectPt.x, intersectPt.y, null, e.shiftKey);
          dispatchInteraction({ type: 'point', point: [x, y, 0] });
          setWallStartPoint([x, y, 0]);
        } else {
          const [x, y] = getSnappedPoint3D(
            intersectPt.x,
            intersectPt.y,
            [start[0], start[1]],
            e.shiftKey
          );
          createWall(start, [x, y, 0]);
          dispatchInteraction({ type: 'commit' });
          setWallStartPoint(null);
          setWallCurrentPoint(null);
        }
        return;
      }

      // Tool: Roof Creation (RF)
      if (activeTool === 'RF') {
        const groundPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
        const intersectPt = new THREE.Vector3();
        raycaster.ray.intersectPlane(groundPlane, intersectPt);

        const start = (interactionSession.picks[0] as [number, number] | undefined) ?? boxStartPoint;
        if (!start) {
          const [x, y] = getSnappedPoint3D(intersectPt.x, intersectPt.y, null, e.shiftKey);
          dispatchInteraction({ type: 'point', point: [x, y] });
          setBoxStartPoint([x, y]);
        } else {
          const [x2, y2] = getSnappedPoint3D(intersectPt.x, intersectPt.y, start, e.shiftKey);
          const minX = Math.min(start[0], x2);
          const maxX = Math.max(start[0], x2);
          const minY = Math.min(start[1], y2);
          const maxY = Math.max(start[1], y2);
          if (maxX - minX >= 0.5 && maxY - minY >= 0.5) {
            createRoof([[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY]], 0.3, 6.0, 15.0);
          }
          dispatchInteraction({ type: 'commit' });
          setBoxStartPoint(null);
          setBoxCurrentPoint(null);
        }
        return;
      }

      // Tool: Slab / Floor Creation (SB)
      if (activeTool === 'SB') {
        const groundPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
        const intersectPt = new THREE.Vector3();
        raycaster.ray.intersectPlane(groundPlane, intersectPt);

        const start = (interactionSession.picks[0] as [number, number] | undefined) ?? boxStartPoint;
        if (!start) {
          const [x, y] = getSnappedPoint3D(intersectPt.x, intersectPt.y, null, e.shiftKey);
          dispatchInteraction({ type: 'point', point: [x, y] });
          setBoxStartPoint([x, y]);
        } else {
          const [x2, y2] = getSnappedPoint3D(intersectPt.x, intersectPt.y, start, e.shiftKey);
          const minX = Math.min(start[0], x2);
          const maxX = Math.max(start[0], x2);
          const minY = Math.min(start[1], y2);
          const maxY = Math.max(start[1], y2);
          if (maxX - minX >= 0.5 && maxY - minY >= 0.5) {
            createSlab([[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY]], 0.25, 0.0);
          }
          dispatchInteraction({ type: 'commit' });
          setBoxStartPoint(null);
          setBoxCurrentPoint(null);
        }
        return;
      }

      // Tool: Door (DR) or Window (WN) placement
      if (activeTool === 'DR' || activeTool === 'WN') {
        // UI-P0-15: the host filter only accepted `IfcWallStandardCase`, but the
        // engine also emits `IfcWall`, so on those walls the click was silently
        // swallowed. Both classes are hostable.
        const wallMeshes = Array.from(threeMeshesRef.current.values()).filter((m) =>
          HOSTABLE_WALL_CLASSES.includes(m.userData.ifc_class)
        );
        const intersects = raycaster.intersectObjects(wallMeshes, false);
        if (intersects.length > 0) {
          const hit = intersects[0];
          const hostWallGuid = hit.object.userData.guid;
          const host = elements[hostWallGuid];
          const offset = offsetAlongBaseline(host, hit.point);

          if (activeTool === 'DR') {
            createDoor(hostWallGuid, offset);
          } else {
            createWindow(hostWallGuid, offset);
          }
          // UI-P0-15: the click that placed the element must not also re-select it.
          placementGuidRef.current = hostWallGuid;
        } else {
          setStatusMessage('Click on a wall to host the door or window.');
        }
        return;
      }

      // Tool: Align & Lock (AL)
      if (activeTool === 'AL') {
        const meshesList = Array.from(threeMeshesRef.current.values());
        const intersects = raycaster.intersectObjects(meshesList, false);
        if (intersects.length > 0) {
          const hitGuid = intersects[0].object.userData.guid;
          if (!alignPickState.refGuid) {
            setAlignPickState({ step: 'pick_target', refGuid: hitGuid });
          } else if (alignPickState.refGuid !== hitGuid) {
            createAlignConstraint(alignPickState.refGuid, hitGuid, 'x', true);
          } else {
            // UI-P0-15: aligning an element to itself used to be a valid command.
            setStatusMessage('Pick a different element to align to the reference.');
          }
        } else {
          setStatusMessage('Pick an element to align.');
        }
        return;
      }

      // Tool: Select (default). UI-P0-15: a click that just completed a placement
      // is consumed by that placement, so drawing does not also re-select.
      if (placementGuidRef.current) {
        const consumed = placementGuidRef.current;
        placementGuidRef.current = null;
        const meshesList = Array.from(threeMeshesRef.current.values());
        const intersects = raycaster.intersectObjects(meshesList, false);
        if (intersects.length > 0 && intersects[0].object.userData.guid === consumed) return;
      }

      const meshesList = Array.from(threeMeshesRef.current.values());
      const intersects = raycaster.intersectObjects(meshesList, false);

      if (intersects.length > 0) {
        const hitGuid = intersects[0].object.userData.guid;
        setSelectedGuid(hitGuid);
      } else {
        setSelectedGuid(null);
      }
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    dispatchInteraction({ type: 'pointer_move', screenPoint: [e.clientX, e.clientY] });

    if (activeDragGripRef.current) {
      const { grip, element } = activeDragGripRef.current;
      if (canvasRef.current && cameraRef.current) {
        const rect = canvasRef.current.getBoundingClientRect();
        const mouse = new THREE.Vector2(
          ((e.clientX - rect.left) / rect.width) * 2 - 1,
          -((e.clientY - rect.top) / rect.height) * 2 + 1
        );
        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(mouse, cameraRef.current);

        let targetPoint: [number, number, number] | null = null;
        if (grip.kind === 'wall_height') {
          const camDir = new THREE.Vector3();
          cameraRef.current.getWorldDirection(camDir);
          const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(
            camDir.clone().negate(),
            new THREE.Vector3(grip.worldPoint[0], grip.worldPoint[1], grip.worldPoint[2])
          );
          const hitPt = new THREE.Vector3();
          if (raycaster.ray.intersectPlane(plane, hitPt)) {
            targetPoint = [hitPt.x, hitPt.y, hitPt.z];
          }
        } else {
          const baseZ = Number(element.start?.[2] ?? 0);
          const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -baseZ);
          const hitPt = new THREE.Vector3();
          if (raycaster.ray.intersectPlane(plane, hitPt)) {
            targetPoint = [hitPt.x, hitPt.y, hitPt.z];
          }
        }

        if (targetPoint) {
          const cmd = computeGripDragCommand(grip, targetPoint, element);
          if (cmd.action === 'modifyWallHeight') {
            modifyWallHeight(element.guid, cmd.params.height);
            setLiveGripValue({ label: 'Wall Height', value: cmd.params.height });
          } else if (cmd.action === 'modifyWallThickness') {
            modifyWallThickness(element.guid, cmd.params.thickness);
            setLiveGripValue({ label: 'Wall Thickness', value: cmd.params.thickness });
          } else if (cmd.action === 'modifyWallEnd') {
            modifyWallEnd(element.guid, cmd.params.end, cmd.params.point);
            const isStart = cmd.params.end === 'start';
            const fixedPt = isStart ? element.end : element.start;
            if (fixedPt) {
              const len = Math.hypot(cmd.params.point[0] - fixedPt[0], cmd.params.point[1] - fixedPt[1]);
              setLiveGripValue({ label: 'Wall Length', value: len });
            }
          }
        }
      }
      return;
    }

    // UI-P0-13: a navigation mode with no button held means the gesture's mouse-up
    // was missed (released off-canvas before capture existed, or a blink). Ending it
    // here is what stops the "the model pans whenever I move the mouse" state.
    if (isNavigatingRef.current.mode && (e.buttons & 4) === 0) {
      isNavigatingRef.current.mode = null;
    }

    // Navigation handling
    if (isNavigatingRef.current.mode) {
      const dx = e.clientX - isNavigatingRef.current.startX;
      const dy = e.clientY - isNavigatingRef.current.startY;
      isNavigatingRef.current.startX = e.clientX;
      isNavigatingRef.current.startY = e.clientY;

      if (isNavigatingRef.current.mode === 'orbit') {
        // Orbit around pivot
        sphericalRef.current.theta -= dx * 0.006;
        sphericalRef.current.phi = Math.max(
          0.05,
          Math.min(Math.PI - 0.05, sphericalRef.current.phi - dy * 0.006)
        );
        updateCameraPosition();
      } else if (isNavigatingRef.current.mode === 'pan') {
        // Pan parallel to screen plane
        if (cameraRef.current) {
          const factor = sphericalRef.current.radius * 0.0015;
          const right = new THREE.Vector3();
          cameraRef.current.getWorldDirection(right);
          right.cross(cameraRef.current.up).normalize();

          const up = cameraRef.current.up.clone().normalize();

          targetRef.current.addScaledVector(right, -dx * factor);
          targetRef.current.addScaledVector(up, dy * factor);
          updateCameraPosition();
        }
      }
      return;
    }

    // Wall creation preview
    if (activeTool === 'WA' && wallStartPoint && cameraRef.current) {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      const mouse = new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1
      );
      const raycaster = new THREE.Raycaster();
      raycaster.setFromCamera(mouse, cameraRef.current);
      const groundPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
      const pt = new THREE.Vector3();
      raycaster.ray.intersectPlane(groundPlane, pt);
      const [x, y] = getSnappedPoint3D(pt.x, pt.y, [wallStartPoint[0], wallStartPoint[1]], e.shiftKey);
      setWallCurrentPoint([x, y, 0]);
    }

    // Roof / Slab creation preview
    if ((activeTool === 'RF' || activeTool === 'SB') && boxStartPoint && cameraRef.current) {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (rect) {
        const mouse = new THREE.Vector2(
          ((e.clientX - rect.left) / rect.width) * 2 - 1,
          -((e.clientY - rect.top) / rect.height) * 2 + 1
        );
        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(mouse, cameraRef.current);
        const groundPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
        const pt = new THREE.Vector3();
        raycaster.ray.intersectPlane(groundPlane, pt);
        const [x, y] = getSnappedPoint3D(pt.x, pt.y, boxStartPoint, e.shiftKey);
        setBoxCurrentPoint([x, y]);
      }
    }
  };

  const handleMouseUp = (e: React.MouseEvent) => {
    if (activeDragGripRef.current) {
      endDrag(true);
      activeDragGripRef.current = null;
      setLiveGripValue(null);
    }
    isNavigatingRef.current.mode = null;
    dispatchInteraction({ type: 'pointer_up', screenPoint: [e.clientX, e.clientY] });
    // UI-P0-13: release the capture taken on mousedown.
    const target = e.currentTarget as CaptureTarget;
    const id = pointerIdOf(e);
    if (target.hasPointerCapture?.(id)) {
      target.releasePointerCapture?.(id);
    }
  };

  /** A pointer that left the viewport must not leave a gesture latched. */
  const handlePointerLeave = () => {
    if (activeDragGripRef.current) {
      endDrag(false);
      activeDragGripRef.current = null;
      setLiveGripValue(null);
    }
    isNavigatingRef.current.mode = null;
  };

  const fitToExtents = useCallback(() => {
    if (meshes.length === 0) {
      targetRef.current.set(6, 4.5, 1.5);
      sphericalRef.current.radius = 22;
      updateCameraPosition();
      return;
    }
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    meshes.forEach((m) => {
      if (m.bbox) {
        minX = Math.min(minX, m.bbox.min[0]);
        minY = Math.min(minY, m.bbox.min[1]);
        minZ = Math.min(minZ, m.bbox.min[2]);
        maxX = Math.max(maxX, m.bbox.max[0]);
        maxY = Math.max(maxY, m.bbox.max[1]);
        maxZ = Math.max(maxZ, m.bbox.max[2]);
      }
    });
    if (minX !== Infinity) {
      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;
      const cz = (minZ + maxZ) / 2;
      const maxDim = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 5);

      targetRef.current.set(cx, cy, cz);
      sphericalRef.current.radius = maxDim * 1.8;
      if (cameraRef.current) {
        cameraRef.current.far = Math.max(10000, maxDim * 20);
        cameraRef.current.updateProjectionMatrix();
      }
      updateCameraPosition();
    }
  }, [meshes, updateCameraPosition]);

  // Auto-fit extents when a new model is loaded.
  //
  // UI-P0-6: the original condition was
  //   projectName changed OR meshes.length !== 0
  // and the second clause is true whenever anything is loaded, so this refit on
  // every `meshes` identity change — i.e. after every single edit — throwing away
  // the camera the user had just positioned. `fitToExtents` also gets a new
  // identity on every mesh update, which re-fired the effect. Fit once per project,
  // and when the model goes from empty to non-empty.
  const prevProjectRef = useRef<string>(projectName);
  const hadMeshesRef = useRef<boolean>(meshes.length > 0);
  useEffect(() => {
    const projectChanged = prevProjectRef.current !== projectName;
    const becameNonEmpty = meshes.length > 0 && !hadMeshesRef.current;
    if (meshes.length > 0 && (projectChanged || becameNonEmpty)) {
      fitToExtents();
      prevProjectRef.current = projectName;
    }
    hadMeshesRef.current = meshes.length > 0;
  }, [projectName, meshes.length, fitToExtents]);

  // Zoom Extents listener. UI-P0-6: one shared event name, and the 2D viewport
  // listens to the same one so `ZE` works in a plan view as well as in 3D.
  useEffect(() => {
    const handleZoomExtents = () => {
      fitToExtents();
    };
    window.addEventListener(ZOOM_EXTENTS_EVENT, handleZoomExtents);
    return () => window.removeEventListener(ZOOM_EXTENTS_EVENT, handleZoomExtents);
  }, [fitToExtents]);

  // Double-click to invoke Revit Sketch Mode on Floor or Roof
  const handleDoubleClick = (e: React.MouseEvent) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect || !cameraRef.current || !sceneRef.current) return;

    const mouse = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1
    );

    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(mouse, cameraRef.current);

    const interactiveMeshes = Array.from(threeMeshesRef.current.values());
    const intersects = raycaster.intersectObjects(interactiveMeshes, false);

    if (intersects.length > 0) {
      const hit = intersects[0];
      const mesh = hit.object as THREE.Mesh;
      const guid = mesh.userData?.guid;
      const ifcClass = mesh.userData?.ifc_class;

      if (ifcClass === 'IfcSlab') {
        startSketchMode('floor', guid);
      } else if (ifcClass === 'IfcRoof') {
        startSketchMode('roof', guid);
      }
    }
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    if (!canvasRef.current || !cameraRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const mouse = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1
    );

    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(mouse, cameraRef.current);
    const interactiveMeshes = Array.from(threeMeshesRef.current.values());
    const intersects = raycaster.intersectObjects(interactiveMeshes, false);

    let hitGuid: string | null = null;
    if (intersects.length > 0) {
      hitGuid = (intersects[0].object as THREE.Mesh).userData?.guid || null;
      if (hitGuid && !selectedGuids.includes(hitGuid)) {
        setSelectedGuid(hitGuid);
      }
    } else {
      hitGuid = selectedGuids.length > 0 ? selectedGuids[selectedGuids.length - 1] : selectedGuid;
    }

    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      guid: hitGuid,
    });
  };

  return (
    <div
      ref={containerRef}
      className="relative w-full h-full bg-[#202022] overflow-hidden select-none cursor-crosshair"
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handlePointerLeave}
      onDoubleClick={handleDoubleClick}
      onContextMenu={handleContextMenu}
    >
      <canvas ref={canvasRef} className="w-full h-full block" />

      {/* WebGL unavailable: explain it rather than showing an empty dark panel. The
          other panels (2D plan, browser, properties) keep working. */}
      {webglError && (
        <div className="absolute inset-0 flex items-center justify-center p-6 z-20">
          <div className="max-w-md space-y-3 text-center">
            <h3 className="text-sm font-semibold text-amber-400">3D view unavailable</h3>
            <p className="text-xs text-[#a0a0a0] leading-relaxed">
              This machine could not create a WebGL context, so the 3D viewport cannot
              draw. The rest of the application still works — switch to the{' '}
              <span className="text-[#d4d4d4]">2D plan</span> view to keep working.
            </p>
            <p className="text-[10px] text-[#707070]">
              Usually a missing or blocklisted GPU driver, or a remote/headless session
              without hardware acceleration.
            </p>
            <pre className="text-[10px] whitespace-pre-wrap break-words bg-[#252526] border border-[#3c3c3c] rounded p-2 text-[#e0a0a0] text-left">
              {webglError}
            </pre>
          </div>
        </div>
      )}

      {/* Viewport Top Controls Overlay */}
      <div className="absolute top-3 left-3 flex items-center space-x-2 bg-[#1e1e1e]/85 backdrop-blur px-2.5 py-1.5 rounded border border-[#3c3c3c] text-xs z-10">
        <span className="font-semibold text-white">Default 3D View: {'{3D}'}</span>
        <span className="text-[#858585]">|</span>
        <button
          onClick={() => window.dispatchEvent(new CustomEvent(ZOOM_EXTENTS_EVENT))}
          className="p-1 hover:bg-[#333333] rounded text-[#cccccc] hover:text-white"
          title="Zoom Extents (ZE or Double-Click MMB)"
        >
          <Maximize size={13} />
        </button>
      </div>

      {/* Phase 3: Direct Manipulation Grips Overlay */}
      {(() => {
        if (!canvasRef.current || !cameraRef.current) return null;
        const rect = canvasRef.current.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return null;
        const camera = cameraRef.current;
        const guidsToInspect = selectedGuids.length > 0 ? selectedGuids : (selectedGuid ? [selectedGuid] : []);

        return guidsToInspect.map((guid) => {
          const el = elements[guid];
          if (!el) return null;
          const grips = gripsFor(el);
          return grips.map((grip) => {
            const v = new THREE.Vector3(grip.worldPoint[0], grip.worldPoint[1], grip.worldPoint[2]);
            v.project(camera);
            if (v.z > 1.0) return null;
            const screenX = ((v.x + 1) / 2) * rect.width;
            const screenY = ((-v.y + 1) / 2) * rect.height;
            const isHovered = hoveredGripId === grip.id;
            const isDragging = activeDragGripRef.current?.grip.id === grip.id;

            return (
              <div
                key={grip.id}
                style={{ left: `${screenX}px`, top: `${screenY}px` }}
                className="absolute -translate-x-1/2 -translate-y-1/2 z-30 group cursor-pointer pointer-events-auto select-none"
                onMouseEnter={() => setHoveredGripId(grip.id)}
                onMouseLeave={() => setHoveredGripId(null)}
                onMouseDown={(e) => {
                  e.stopPropagation();
                  e.preventDefault();
                  activeDragGripRef.current = { grip, element: el };
                  beginDrag(`Drag ${grip.label}`);
                }}
                title={`${grip.label}: Drag to adjust`}
              >
                {/* Enlarged invisible hit proxy (28x28 px) */}
                <div className="absolute -inset-2 w-7 h-7 -translate-x-1/2 -translate-y-1/2 left-1/2 top-1/2 cursor-pointer z-10" />

                {/* Visible grip marker */}
                <div
                  className={`w-3.5 h-3.5 rounded-full border-2 shadow-md transition-all flex items-center justify-center ${
                    isDragging || isHovered
                      ? 'bg-[#38bdf8] border-white scale-125 ring-2 ring-sky-400'
                      : 'bg-[#0284c7] border-white hover:scale-125 hover:bg-[#38bdf8]'
                  }`}
                >
                  <div className="w-1 h-1 rounded-full bg-white" />
                </div>

                {/* Hover tooltip */}
                <div
                  className={`absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 px-2 py-0.5 bg-black/90 text-white text-[10px] font-mono whitespace-nowrap rounded pointer-events-none shadow border border-sky-500/40 ${
                    isHovered || isDragging ? 'block' : 'hidden group-hover:block'
                  }`}
                >
                  {grip.label}: {formatLength(grip.value, displayUnit)}
                </div>
              </div>
            );
          });
        });
      })()}

      {/* Phase 4: Value Control Box & Direct Numeric Entry HUD */}
      <ValueControlBox
        currentLiveValue={
          activeTool === 'WA' && wallStartPoint && wallCurrentPoint
            ? Math.hypot(wallCurrentPoint[0] - wallStartPoint[0], wallCurrentPoint[1] - wallStartPoint[1])
            : liveGripValue?.value ?? null
        }
        liveLabel={
          activeTool === 'WA' && wallStartPoint
            ? 'Wall Length'
            : liveGripValue?.label
        }
        onCommitLiveValue={handleCommitLiveValue}
        className="absolute top-14 left-1/2 -translate-x-1/2 z-20"
      />

      {/* Phase 5: 3D Snap Indicator & Cursor Label */}
      {(() => {
        if (!activeSnapCandidate || !cameraRef.current || !canvasRef.current) return null;
        const rect = canvasRef.current.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return null;
        const v = new THREE.Vector3(activeSnapCandidate.point[0], activeSnapCandidate.point[1], 0);
        v.project(cameraRef.current);
        if (v.z > 1.0) return null;
        const screenX = ((v.x + 1) / 2) * rect.width;
        const screenY = ((-v.y + 1) / 2) * rect.height;

        return (
          <div
            style={{ left: `${screenX}px`, top: `${screenY}px` }}
            className="absolute -translate-x-1/2 -translate-y-1/2 z-30 pointer-events-none select-none flex items-center space-x-1.5"
          >
            <div className="w-3.5 h-3.5 border-2 border-[#ec4899] rounded-sm bg-[#ec4899]/20 shadow flex items-center justify-center">
              <div className="w-1 h-1 bg-[#ec4899] rounded-full" />
            </div>
            <span className="px-1.5 py-0.5 bg-black/85 text-[#f472b6] font-mono text-[10px] rounded border border-[#ec4899]/40 whitespace-nowrap shadow-md">
              {activeSnapCandidate.description}
            </span>
          </div>
        );
      })()}

      {/* Wall Placement Status Banner */}
      {activeTool === 'WA' && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-[#094771]/90 backdrop-blur px-4 py-2 rounded-lg border border-[#007acc] text-xs text-white shadow-xl flex items-center space-x-3 z-10 animate-fade-in">
          <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping" />
          <span>
            {wallStartPoint
              ? `Click endpoint to complete wall (${formatLength(
                  Math.hypot(
                    (wallCurrentPoint?.[0] || 0) - wallStartPoint[0],
                    (wallCurrentPoint?.[1] || 0) - wallStartPoint[1]
                  ),
                  displayUnit
                )})`
              : 'Click start point for wall baseline'}
          </span>
          <button
            onClick={() => {
              // UI-P0-11: clear both points, not just the start. The original left
              // `wallCurrentPoint` behind, so the banner kept showing a stale length.
              setActiveTool('select');
              setWallStartPoint(null);
              setWallCurrentPoint(null);
            }}
            className="px-2 py-0.5 bg-[#3c3c3c] hover:bg-[#4a4a4a] rounded text-[10px]"
          >
            Cancel (Esc)
          </button>
        </div>
      )}

      {/* Roof Placement Status Banner */}
      {activeTool === 'RF' && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-[#094771]/90 backdrop-blur px-4 py-2 rounded-lg border border-[#007acc] text-xs text-white shadow-xl flex items-center space-x-3 z-10 animate-fade-in">
          <span className="w-2 h-2 rounded-full bg-amber-400 animate-ping" />
          <span>
            {boxStartPoint
              ? `Click opposite corner to complete roof (${formatLength(
                  Math.abs((boxCurrentPoint?.[0] || 0) - boxStartPoint[0]),
                  displayUnit
                )} × ${formatLength(Math.abs((boxCurrentPoint?.[1] || 0) - boxStartPoint[1]), displayUnit)})`
              : 'Click 1st corner for roof boundary footprint'}
          </span>
          <button
            onClick={() => {
              setActiveTool('select');
              setBoxStartPoint(null);
              setBoxCurrentPoint(null);
            }}
            className="px-2 py-0.5 bg-[#3c3c3c] hover:bg-[#4a4a4a] rounded text-[10px]"
          >
            Cancel (Esc)
          </button>
        </div>
      )}

      {/* Slab Placement Status Banner */}
      {activeTool === 'SB' && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-[#094771]/90 backdrop-blur px-4 py-2 rounded-lg border border-[#007acc] text-xs text-white shadow-xl flex items-center space-x-3 z-10 animate-fade-in">
          <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping" />
          <span>
            {boxStartPoint
              ? `Click opposite corner to complete floor slab (${formatLength(
                  Math.abs((boxCurrentPoint?.[0] || 0) - boxStartPoint[0]),
                  displayUnit
                )} × ${formatLength(Math.abs((boxCurrentPoint?.[1] || 0) - boxStartPoint[1]), displayUnit)})`
              : 'Click 1st corner for floor slab boundary'}
          </span>
          <button
            onClick={() => {
              setActiveTool('select');
              setBoxStartPoint(null);
              setBoxCurrentPoint(null);
            }}
            className="px-2 py-0.5 bg-[#3c3c3c] hover:bg-[#4a4a4a] rounded text-[10px]"
          >
            Cancel (Esc)
          </button>
        </div>
      )}

      {/* Align Tool Status Banner */}
      {activeTool === 'AL' && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-[#094771]/95 backdrop-blur px-4 py-2 rounded-lg border border-[#38bdf8] text-xs text-white shadow-xl flex items-center space-x-3 z-10 animate-fade-in">
          <Lock size={15} className="text-[#38bdf8] animate-pulse" />
          <span>
            {!alignPickState.refGuid
              ? 'ALIGN (AL): Pick reference edge or element in 3D'
              : 'Reference picked. Now pick target element to align & lock.'}
          </span>
          <button
            onClick={() => {
              setActiveTool('select');
              setAlignPickState({ step: null, refGuid: null });
            }}
            className="px-2 py-0.5 bg-[#3c3c3c] hover:bg-[#4a4a4a] rounded text-[10px]"
          >
            Cancel (Esc)
          </button>
        </div>
      )}

      {/* Revit Sketch Mode Active Banner */}
      {sketchSession && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-[#064e3b]/95 backdrop-blur px-5 py-2.5 rounded-xl border border-emerald-500 text-xs text-white shadow-2xl flex items-center space-x-4 z-20 animate-fade-in">
          <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse" />
          <span className="font-bold tracking-wide text-emerald-200 uppercase text-[11px]">
            {sketchSession.isEditingExisting ? 'Edit Mode' : 'Create Mode'}
          </span>
          <span className="text-slate-200 font-sans">
            {sketchSession.elementType === 'floor' ? 'Floor Boundary' : 'Roof Footprint'} — Switch to 2D Plan to draw magenta boundary lines
          </span>
          <div className="flex items-center space-x-2 pl-2">
            <button
              onClick={() => finishSketchMode()}
              className="flex items-center space-x-1 px-3 py-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded font-semibold text-xs transition-colors shadow"
              title="Finish Edit Mode (Enter)"
            >
              Finish
            </button>
            <button
              onClick={() => cancelSketchMode()}
              className="flex items-center space-x-1 px-2.5 py-1 bg-red-600/80 hover:bg-red-600 text-white rounded font-medium text-xs transition-colors"
              title="Cancel Edit Mode (Esc)"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Right-Click Context Menu */}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          targetGuid={contextMenu.guid}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
};
