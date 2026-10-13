import React, { useEffect, useRef, useState, useCallback } from 'react';
import * as THREE from 'three';
import { useBimStore } from '../../store/useBimStore';
import { Scissors, Maximize, RotateCw, Move, Lock } from 'lucide-react';

export const Viewport3D: React.FC = () => {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const {
    meshes,
    grids,
    levels,
    selectedGuid,
    setSelectedGuid,
    hoveredGuid,
    setHoveredGuid,
    activeTool,
    setActiveTool,
    createWall,
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
  } = useBimStore();

  // Internal Three.js state
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
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
  const [editingDimValue, setEditingDimValue] = useState<string>('');
  const [isEditingDim, setIsEditingDim] = useState<boolean>(false);

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

    const renderer = new THREE.WebGLRenderer({
      canvas: canvasRef.current,
      antialias: true,
      stencil: true, // For real-time section box solid capping
    });
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
      cameraRef.current.aspect = w / h;
      cameraRef.current.updateProjectionMatrix();
      rendererRef.current.setSize(w, h);
    };
    window.addEventListener('resize', handleResize);

    return () => {
      cancelAnimationFrame(animationFrameId);
      window.removeEventListener('resize', handleResize);
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
        sceneRef.current.remove(sectionBoxMeshRef.current);
      }
      const boxGeom = new THREE.BoxGeometry(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
      const edges = new THREE.EdgesGeometry(boxGeom);
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
        sceneRef.current.remove(sectionBoxMeshRef.current);
        sectionBoxMeshRef.current = null;
      }
    }
  }, [sectionBox]);

  // Populate IFC Elements Meshes in Three.js Scene
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;

    // Clear previous elements
    threeMeshesRef.current.forEach((mesh) => scene.remove(mesh));
    threeMeshesRef.current.clear();

    meshes.forEach((mData) => {
      // Check visibility filter
      if (hiddenGuids.includes(mData.guid)) return;
      if (isolatedGuids.length > 0 && !isolatedGuids.includes(mData.guid)) return;

      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.Float32BufferAttribute(mData.vertices, 3));
      geom.setIndex(mData.indices);
      geom.computeVertexNormals();

      const isSelected = selectedGuid === mData.guid;
      const isHovered = hoveredGuid === mData.guid;

      let color = mData.color;
      let opacity = mData.opacity;

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
        });
      } else if (activeVisualStyle === 'hidden_line') {
        mat = new THREE.MeshLambertMaterial({
          color: isSelected ? 0x0284c7 : 0xffffff,
          clippingPlanes: clippingPlanesRef.current,
        });
      } else {
        // Consistent colors (Revit default)
        mat = new THREE.MeshStandardMaterial({
          color: new THREE.Color(color),
          roughness: 0.8,
          metalness: 0.1,
          transparent: opacity < 1.0,
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
        })
      );
      mesh.add(edgeLine);

      scene.add(mesh);
      threeMeshesRef.current.set(mData.guid, mesh);
    });
  }, [meshes, selectedGuid, hoveredGuid, hiddenGuids, isolatedGuids, activeVisualStyle]);

  // Handle Revit Navigation Events:
  // - Shift + MMB: Orbit
  // - MMB: Pan
  // - Wheel: Zoom
  // - Z+E: Zoom Extents
  const handleMouseDown = (e: React.MouseEvent) => {
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

        if (!wallStartPoint) {
          // First point: snap to nearest 0.5m
          const x = Math.round(intersectPt.x * 2) / 2;
          const y = Math.round(intersectPt.y * 2) / 2;
          setWallStartPoint([x, y, 0]);
        } else {
          // Second point: create wall
          const x = Math.round(intersectPt.x * 2) / 2;
          const y = Math.round(intersectPt.y * 2) / 2;
          createWall(wallStartPoint, [x, y, 0]);
          setWallStartPoint(null);
          setWallCurrentPoint(null);
        }
        return;
      }

      // Tool: Door (DR) or Window (WN) placement
      if (activeTool === 'DR' || activeTool === 'WN') {
        const wallMeshes = Array.from(threeMeshesRef.current.values()).filter(
          (m) => m.userData.ifc_class === 'IfcWallStandardCase'
        );
        const intersects = raycaster.intersectObjects(wallMeshes, false);
        if (intersects.length > 0) {
          const hit = intersects[0];
          const hostWallGuid = hit.object.userData.guid;
          // Approximate offset along wall baseline
          const offset = Math.max(0.8, Math.hypot(hit.point.x, hit.point.y) * 0.4);

          if (activeTool === 'DR') {
            createDoor(hostWallGuid, offset);
          } else {
            createWindow(hostWallGuid, offset);
          }
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
          } else {
            createAlignConstraint(alignPickState.refGuid, hitGuid, 'x', true);
          }
        }
        return;
      }

      // Tool: Select (default)
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
      setWallCurrentPoint([
        Math.round(pt.x * 2) / 2,
        Math.round(pt.y * 2) / 2,
        0,
      ]);
    }
  };

  const handleMouseUp = () => {
    isNavigatingRef.current.mode = null;
  };

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const zoomFactor = e.deltaY > 0 ? 1.15 : 0.85;
    sphericalRef.current.radius = Math.max(1, Math.min(200, sphericalRef.current.radius * zoomFactor));
    updateCameraPosition();
  };

  // Zoom Extents listener
  useEffect(() => {
    const handleZoomExtents = () => {
      targetRef.current.set(6, 4.5, 1.5);
      sphericalRef.current.radius = 22;
      sphericalRef.current.theta = Math.PI / 4;
      sphericalRef.current.phi = Math.PI / 3;
      updateCameraPosition();
    };
    window.addEventListener('orlt-zoom-extents', handleZoomExtents);
    return () => window.removeEventListener('orlt-zoom-extents', handleZoomExtents);
  }, [updateCameraPosition]);

  return (
    <div
      ref={containerRef}
      className="relative w-full h-full bg-[#202022] overflow-hidden select-none cursor-crosshair"
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onWheel={handleWheel}
      onContextMenu={(e) => e.preventDefault()}
    >
      <canvas ref={canvasRef} className="w-full h-full block" />

      {/* Viewport Top Controls Overlay */}
      <div className="absolute top-3 left-3 flex items-center space-x-2 bg-[#1e1e1e]/85 backdrop-blur px-2.5 py-1.5 rounded border border-[#3c3c3c] text-xs z-10">
        <span className="font-semibold text-white">Default 3D View: {'{3D}'}</span>
        <span className="text-[#858585]">|</span>
        <button
          onClick={() => window.dispatchEvent(new CustomEvent('orlt-zoom-extents'))}
          className="p-1 hover:bg-[#333333] rounded text-[#cccccc] hover:text-white"
          title="Zoom Extents (ZE or Double-Click MMB)"
        >
          <Maximize size={13} />
        </button>
      </div>

      {/* Dynamic Temporary Dimension Pill Overlay */}
      {tempDimension && (
        <div className="absolute top-14 left-1/2 -translate-x-1/2 z-20 flex items-center space-x-2 bg-[#0284c7] text-white px-3 py-1 rounded shadow-lg border border-[#38bdf8] text-xs font-mono">
          <span className="text-[11px] font-semibold">Distance:</span>
          {isEditingDim ? (
            <input
              type="text"
              autoFocus
              value={editingDimValue}
              onChange={(e) => setEditingDimValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  const val = parseFloat(editingDimValue);
                  if (!isNaN(val) && val > 0) {
                    applyTemporaryDimensionChange(val);
                  }
                  setIsEditingDim(false);
                } else if (e.key === 'Escape') {
                  setIsEditingDim(false);
                }
              }}
              className="w-20 px-1 py-0.5 bg-black/50 text-white rounded border border-white text-xs font-mono"
            />
          ) : (
            <span
              onClick={() => {
                setEditingDimValue(tempDimension.distance.toFixed(2));
                setIsEditingDim(true);
              }}
              className="underline cursor-pointer hover:text-yellow-200"
              title="Click to change dimension and translate element"
            >
              {tempDimension.displayValue}
            </span>
          )}
          <span className="text-[10px] text-sky-200">(Click to edit)</span>
        </div>
      )}

      {/* Wall Placement Status Banner */}
      {activeTool === 'WA' && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-[#094771]/90 backdrop-blur px-4 py-2 rounded-lg border border-[#007acc] text-xs text-white shadow-xl flex items-center space-x-3 z-10 animate-fade-in">
          <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping" />
          <span>
            {wallStartPoint
              ? `Click endpoint to complete wall (${(
                  Math.hypot(
                    (wallCurrentPoint?.[0] || 0) - wallStartPoint[0],
                    (wallCurrentPoint?.[1] || 0) - wallStartPoint[1]
                  )
                ).toFixed(2)} m)`
              : 'Click start point for wall baseline'}
          </span>
          <button
            onClick={() => {
              setActiveTool('select');
              setWallStartPoint(null);
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
    </div>
  );
};
