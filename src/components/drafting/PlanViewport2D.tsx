import React, { useState, useRef, useCallback, useEffect } from 'react';
import { useBimStore } from '../../store/useBimStore';
import { Maximize2, ZoomIn, ZoomOut, Lock, Equal, Check, X } from 'lucide-react';

export const PlanViewport2D: React.FC = () => {
  const {
    sliced2D,
    selectedGuid,
    setSelectedGuid,
    tempDimension,
    applyTemporaryDimensionChange,
    constraints,
    toggleConstraintLock,
    lockDimension,
    equalizeSouthWallWindows,
    activeTool,
    alignPickState,
    setAlignPickState,
    createAlignConstraint,
    setActiveTool,
    elements,
    meshes,
    createWall,
    createRoof,
    createSlab,
    createDoor,
    createWindow,
    activeViewId,
    views,
    sketchSession,
    startSketchMode,
    cancelSketchMode,
    finishSketchMode,
    addSketchLine,
    addSketchRectangle,
    addSketchFromWall,
    selectSketchLine,
    deleteSelectedSketchLine,
  } = useBimStore();

  const containerRef = useRef<HTMLDivElement>(null);

  const [firstPoint, setFirstPoint] = useState<[number, number] | null>(null);
  const [currentPoint, setCurrentPoint] = useState<[number, number] | null>(null);
  const [sketchStartPoint, setSketchStartPoint] = useState<[number, number] | null>(null);

  // Helper to snap to nearest existing sketch vertex within tolerance
  const findSnapVertex = useCallback(
    (arg1: number | [number, number], arg2?: number, tol = 0.35): [number, number] | null => {
      if (!sketchSession) return null;
      let mx: number, my: number;
      if (Array.isArray(arg1)) {
        mx = arg1[0];
        my = arg1[1];
      } else {
        mx = arg1;
        my = arg2 ?? 0;
      }
      for (const l of sketchSession.lines) {
        if (Math.hypot(l.start[0] - mx, l.start[1] - my) <= tol) {
          return l.start;
        }
        if (Math.hypot(l.end[0] - mx, l.end[1] - my) <= tol) {
          return l.end;
        }
      }
      return null;
    },
    [sketchSession]
  );

  const handleElementClick = (guid: string) => {
    if (sketchSession) {
      if (sketchSession.drawTool === 'pick_walls') {
        const el = elements[guid];
        if (el?.ifc_class === 'IfcWallStandardCase' || el?.ifc_class === 'IfcWall') {
          addSketchFromWall(guid);
        }
      }
      return;
    }

    if (activeTool === 'AL') {
      if (!alignPickState.refGuid) {
        setAlignPickState({ step: 'pick_target', refGuid: guid });
      } else {
        createAlignConstraint(alignPickState.refGuid, guid, 'x', true);
      }
      return;
    }
    setSelectedGuid(guid);
  };

  const handleDoubleClick = () => {
    if (selectedGuid && !sketchSession) {
      const el = elements[selectedGuid];
      const mesh = meshes.find((m) => m.guid === selectedGuid);
      const ifcClass = el?.ifc_class || mesh?.ifc_class;
      const name = (el?.name || mesh?.name || '').toLowerCase();
      if (ifcClass === 'IfcSlab' && !name.includes('roof')) {
        startSketchMode('floor', selectedGuid);
      } else if (ifcClass === 'IfcRoof' || name.includes('roof')) {
        startSketchMode('roof', selectedGuid);
      }
    }
  };

  const [pan, setPan] = useState<{ x: number; y: number }>({ x: 300, y: 300 });
  const [scale, setScale] = useState<number>(38); // pixels per meter
  const isPanningRef = useRef<boolean>(false);
  const startMouseRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  const [editingDimValue, setEditingDimValue] = useState<string>('');
  const [isEditingDim, setIsEditingDim] = useState<boolean>(false);

  // Convert client mouse coordinates to 2D model coordinates with 0.25m snapping
  const getModelCoords = useCallback(
    (clientX: number, clientY: number): [number, number] | null => {
      if (!containerRef.current) return null;
      const rect = containerRef.current.getBoundingClientRect();
      const svgX = clientX - rect.left;
      const svgY = clientY - rect.top;
      const modelX = (svgX - pan.x) / scale;
      const modelY = -(svgY - pan.y) / scale;
      const snap = 0.25;
      const snappedX = Math.round(modelX / snap) * snap;
      const snappedY = Math.round(modelY / snap) * snap;
      return [snappedX, snappedY];
    },
    [pan, scale]
  );

  // Cancel tool on Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (activeTool !== 'select') {
          setActiveTool('select');
          setFirstPoint(null);
          setCurrentPoint(null);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeTool, setActiveTool]);

  // Reset points when active tool changes
  useEffect(() => {
    setFirstPoint(null);
    setCurrentPoint(null);
  }, [activeTool]);

  // Mouse interaction: Panning vs Geometry Authoring
  const handleMouseDown = (e: React.MouseEvent) => {
    // MMB always pans
    if (e.button === 1) {
      isPanningRef.current = true;
      startMouseRef.current = { x: e.clientX, y: e.clientY };
      return;
    }

    // LMB
    if (e.button === 0) {
      if (activeTool === 'select') {
        isPanningRef.current = true;
        startMouseRef.current = { x: e.clientX, y: e.clientY };
        return;
      }

      const coords = getModelCoords(e.clientX, e.clientY);
      if (!coords) return;
      const [x, y] = coords;

      if (sketchSession) {
        const snap = findSnapVertex(x, y);
        const finalX = snap ? snap[0] : x;
        const finalY = snap ? snap[1] : y;

        if (sketchSession.drawTool === 'line') {
          if (!sketchStartPoint) {
            setSketchStartPoint([finalX, finalY]);
          } else {
            addSketchLine(sketchStartPoint, [finalX, finalY]);
            // Chain to next point (Revit chain sketch mode)
            setSketchStartPoint([finalX, finalY]);
          }
        } else if (sketchSession.drawTool === 'rectangle') {
          if (!sketchStartPoint) {
            setSketchStartPoint([finalX, finalY]);
          } else {
            addSketchRectangle(sketchStartPoint, [finalX, finalY]);
            setSketchStartPoint(null);
          }
        }
        return;
      }

      if (activeTool === 'WA') {
        if (!firstPoint) {
          setFirstPoint([x, y]);
        } else {
          if (Math.hypot(x - firstPoint[0], y - firstPoint[1]) >= 0.5) {
            createWall([firstPoint[0], firstPoint[1], 0], [x, y, 0]);
          }
          setFirstPoint(null);
          setCurrentPoint(null);
        }
      } else if (activeTool === 'RF') {
        startSketchMode('roof');
      } else if (activeTool === 'SB') {
        startSketchMode('floor');
      } else if (activeTool === 'DR' || activeTool === 'WN') {
        let nearestWallGuid: string | null = null;
        let minDist = 2.0;
        let hostOffset = 1.0;

        sliced2D?.cut_paths?.forEach((cp) => {
          const elem = elements[cp.guid];
          if (elem && elem.start && elem.end) {
            const sx = elem.start[0], sy = elem.start[1];
            const ex = elem.end[0], ey = elem.end[1];
            const len = Math.hypot(ex - sx, ey - sy);
            if (len > 0.01) {
              const ux = (ex - sx) / len, uy = (ey - sy) / len;
              const proj = (x - sx) * ux + (y - sy) * uy;
              if (proj >= 0 && proj <= len) {
                const perp = Math.hypot(x - (sx + ux * proj), y - (sy + uy * proj));
                if (perp < minDist) {
                  minDist = perp;
                  nearestWallGuid = cp.guid;
                  hostOffset = proj;
                }
              }
            }
          }
        });

        if (nearestWallGuid) {
          if (activeTool === 'DR') {
            createDoor(nearestWallGuid, hostOffset);
          } else {
            createWindow(nearestWallGuid, hostOffset);
          }
        }
      }
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (isPanningRef.current) {
      const dx = e.clientX - startMouseRef.current.x;
      const dy = e.clientY - startMouseRef.current.y;
      startMouseRef.current = { x: e.clientX, y: e.clientY };
      setPan((p) => ({ x: p.x + dx, y: p.y + dy }));
    } else if (activeTool !== 'select') {
      const coords = getModelCoords(e.clientX, e.clientY);
      if (coords) {
        setCurrentPoint(coords);
      }
    }
  };

  const handleMouseUp = () => {
    isPanningRef.current = false;
  };

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const factor = e.deltaY > 0 ? 0.9 : 1.1;
    setScale((s) => Math.max(8, Math.min(250, s * factor)));
  };

  const fit2DToExtents = useCallback(() => {
    if (!sliced2D) return;
    const pathsToFit = (sliced2D.cut_paths && sliced2D.cut_paths.length > 0)
      ? sliced2D.cut_paths
      : [
          ...(sliced2D.projection_paths || []),
          ...(sliced2D.roofs || []),
          ...(sliced2D.slabs || []),
        ];

    if (pathsToFit.length === 0) {
      setPan({ x: 350, y: 320 });
      setScale(40);
      return;
    }

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    pathsToFit.forEach((p) => {
      const matches = p.d.matchAll(/([ML])\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/g);
      for (const m of matches) {
        const x = parseFloat(m[2]);
        const y = parseFloat(m[3]);
        if (!isNaN(x) && !isNaN(y)) {
          minX = Math.min(minX, x);
          maxX = Math.max(maxX, x);
          minY = Math.min(minY, y);
          maxY = Math.max(maxY, y);
        }
      }
    });

    if (minX !== Infinity && maxX > minX && maxY > minY) {
      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;
      const w = Math.max(maxX - minX, 1);
      const h = Math.max(maxY - minY, 1);
      const containerW = containerRef.current?.clientWidth || 800;
      const containerH = containerRef.current?.clientHeight || 600;
      const fitScale = Math.min((containerW * 0.78) / w, (containerH * 0.78) / h);
      const newScale = Math.max(10, Math.min(150, fitScale));
      setScale(newScale);
      setPan({
        x: containerW / 2 - cx * newScale,
        y: containerH / 2 + cy * newScale,
      });
    }
  }, [sliced2D]);

  const resetView = fit2DToExtents;

  useEffect(() => {
    if (
      sliced2D &&
      (sliced2D.cut_paths?.length ||
        sliced2D.projection_paths?.length ||
        sliced2D.roofs?.length ||
        sliced2D.slabs?.length)
    ) {
      fit2DToExtents();
    }
  }, [sliced2D, fit2DToExtents]);

  const isDrawing = activeTool !== 'select' && activeTool !== 'AL';

  return (
    <div
      ref={containerRef}
      className={`relative w-full h-full bg-[#ffffff] overflow-hidden select-none ${
        isDrawing ? 'cursor-crosshair' : 'cursor-grab active:cursor-grabbing'
      }`}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onWheel={handleWheel}
      onDoubleClick={handleDoubleClick}
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* 2D Vector Drawing Layer */}
      <svg
        className="w-full h-full block"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          {/* Architectural Concrete Hatch Pattern */}
          <pattern
            id="hatch-concrete"
            patternUnits="userSpaceOnUse"
            width="8"
            height="8"
            patternTransform="rotate(45)"
          >
            <line x1="0" y1="0" x2="0" y2="8" stroke="#94a3b8" strokeWidth="0.8" />
            <circle cx="2" cy="4" r="0.6" fill="#64748b" />
            <circle cx="6" cy="2" r="0.6" fill="#64748b" />
          </pattern>
        </defs>

        {/* Global Transform: Pan & Scale */}
        <g transform={`translate(${pan.x}, ${pan.y}) scale(${scale}, ${-scale})`}>
          {/* Base Model Linework (Halftoned/Dimmed during Sketch Mode) */}
          <g className={sketchSession ? 'opacity-25 transition-opacity' : ''}>
            {/* 1. Slabs in Projection */}
            {sliced2D?.slabs.map((slab) => {
              if (sketchSession?.isEditingExisting && sketchSession.targetGuid === slab.guid) return null;
              const isSelected = selectedGuid === slab.guid;
              return (
                <path
                  key={`slab-${slab.guid}`}
                  d={slab.d}
                  className={`${slab.class} cursor-pointer transition-colors`}
                  stroke={isSelected ? '#0284c7' : '#94a3b8'}
                  strokeWidth={isSelected ? '2.0' : '0.8'}
                  vectorEffect="non-scaling-stroke"
                  fill={isSelected ? '#bae6fd' : '#f8fafc'}
                  fillOpacity={isSelected ? 0.5 : 0.4}
                  onClick={(e) => {
                    e.stopPropagation();
                    handleElementClick(slab.guid);
                  }}
                />
              );
            })}

          {/* 1b. Roofs in Projection (Boundary, Ridge, and Pitch Slope) */}
          {sliced2D?.roofs?.map((roof) => {
            if (sketchSession?.isEditingExisting && sketchSession.targetGuid === roof.guid) return null;
            const isSelected = selectedGuid === roof.guid;
            return (
              <g
                key={`roof-${roof.guid}`}
                onClick={(e) => {
                  e.stopPropagation();
                  handleElementClick(roof.guid);
                }}
                className="cursor-pointer"
              >
                <path
                  d={roof.d}
                  stroke={isSelected ? '#0284c7' : '#475569'}
                  strokeWidth={isSelected ? '2.5' : '1.5'}
                  strokeDasharray={roof.is_overhead ? '6 3' : 'none'}
                  vectorEffect="non-scaling-stroke"
                  fill={isSelected ? '#bae6fd' : '#e2e8f0'}
                  fillOpacity={isSelected ? 0.45 : 0.25}
                />
                {roof.ridge_d && (
                  <path
                    d={roof.ridge_d}
                    stroke={isSelected ? '#0284c7' : '#334155'}
                    strokeWidth="1.5"
                    strokeDasharray={roof.is_overhead ? '4 2' : 'none'}
                    vectorEffect="non-scaling-stroke"
                  />
                )}
                {roof.center && roof.pitch_text && (
                  <text
                    x={roof.center[0]}
                    y={-roof.center[1]}
                    transform="scale(1, -1)"
                    textAnchor="middle"
                    dominantBaseline="central"
                    fontSize="0.22"
                    fontFamily="Inter, sans-serif"
                    fontWeight="600"
                    fill={isSelected ? '#0284c7' : '#334155'}
                    paintOrder="stroke"
                    stroke="#ffffff"
                    strokeWidth="0.08"
                  >
                    {roof.pitch_text}
                  </text>
                )}
              </g>
            );
          })}

          {/* 2. Datum Grids */}
          {sliced2D?.grids.map((grid) => (
            <g key={`grid-${grid.guid}`}>
              <path
                d={grid.d}
                stroke="#64748b"
                strokeWidth="1.2"
                vectorEffect="non-scaling-stroke"
                strokeDasharray="8 4 2 4"
              />
              {/* Grid Bubble Circle */}
              <circle
                cx={grid.circle_center[0]}
                cy={grid.circle_center[1]}
                r="0.26"
                fill="#ffffff"
                stroke="#0f172a"
                strokeWidth="1.2"
                vectorEffect="non-scaling-stroke"
              />
              {/* Inverted text scale to render right-side up */}
              <text
                x={grid.circle_center[0]}
                y={-grid.circle_center[1]}
                transform="scale(1, -1)"
                textAnchor="middle"
                dominantBaseline="central"
                fontSize="0.24"
                fontFamily="Inter, sans-serif"
                fontWeight="bold"
                fill="#0f172a"
              >
                {grid.tag}
              </text>
            </g>
          ))}

          {/* 3. Cut Elements (Walls) */}
          {sliced2D?.cut_paths.map((p, idx) => {
            const isSelected = selectedGuid === p.guid;
            return (
              <path
                key={`cut-${idx}`}
                d={p.d}
                stroke={isSelected ? '#0284c7' : '#0f172a'}
                strokeWidth={isSelected ? '2.5' : '1.75'}
                vectorEffect="non-scaling-stroke"
                strokeLinejoin="round"
                strokeLinecap="round"
                fill={isSelected ? '#bae6fd' : '#f1f5f9'}
                onClick={(e) => {
                  e.stopPropagation();
                  handleElementClick(p.guid);
                }}
                className={`${p.class} cursor-pointer transition-colors`}
              />
            );
          })}

          {/* 4. Projections (Sills, Jambs, Sliding panels) */}
          {sliced2D?.projection_paths.map((p, idx) => (
            <path
              key={`proj-${idx}`}
              d={p.d}
              className={p.class}
              stroke="#64748b"
              strokeWidth="1.0"
              vectorEffect="non-scaling-stroke"
              fill="none"
              style={{ fill: 'none' }}
            />
          ))}

          {/* 5. Door Swings */}
          {sliced2D?.swing_paths.map((p, idx) => (
            <path
              key={`swing-${idx}`}
              d={p.d}
              className={p.class}
              stroke="#475569"
              strokeWidth="1.0"
              vectorEffect="non-scaling-stroke"
              fill="none"
              style={{ fill: 'none' }}
            />
          ))}

          {/* 6. Associative Dimensions with Interactive Padlock & EQ Toggles */}
          {sliced2D?.dimensions.map((dim, idx) => {
            const isSelected = selectedGuid === dim.guid;
            const offDist = 0.8;
            const dx = dim.offset_norm[0] * offDist;
            const dy = dim.offset_norm[1] * offDist;
            const mx = (dim.start[0] + dim.end[0]) / 2 + dx;
            const my = (dim.start[1] + dim.end[1]) / 2 + dy;

            // Check if dimension is locked or equalized
            const dimConstraint = constraints.find(
              (c) => c.type === 'dimension_lock' && (c.guid_a === dim.guid || c.guid_b === dim.guid)
            );
            const isLocked = dimConstraint ? dimConstraint.is_locked : false;
            const isEq = constraints.some(
              (c) =>
                c.type === 'equalize' &&
                c.is_equalized &&
                (c.interior_guids?.includes(dim.guid) ||
                  c.span_start_guid === dim.guid ||
                  c.span_end_guid === dim.guid)
            );
            const showBadges = isSelected || isLocked || isEq;

            return (
              <g key={`dim-${idx}`} className="text-dimension select-none">
                {/* Witness lines from wall to dimension line */}
                <line
                  x1={dim.start[0]}
                  y1={dim.start[1]}
                  x2={dim.start[0] + dx * 1.15}
                  y2={dim.start[1] + dy * 1.15}
                  stroke="#94a3b8"
                  strokeWidth="0.8"
                  vectorEffect="non-scaling-stroke"
                />
                <line
                  x1={dim.end[0]}
                  y1={dim.end[1]}
                  x2={dim.end[0] + dx * 1.15}
                  y2={dim.end[1] + dy * 1.15}
                  stroke="#94a3b8"
                  strokeWidth="0.8"
                  vectorEffect="non-scaling-stroke"
                />

                {/* Dimension line */}
                <line
                  x1={dim.start[0] + dx}
                  y1={dim.start[1] + dy}
                  x2={dim.end[0] + dx}
                  y2={dim.end[1] + dy}
                  stroke={isSelected ? '#0284c7' : '#64748b'}
                  strokeWidth="1.0"
                  vectorEffect="non-scaling-stroke"
                />

                {/* Dimension Text with readability halo */}
                <text
                  x={mx}
                  y={-my - 0.10}
                  transform="scale(1, -1)"
                  textAnchor="middle"
                  fontSize="0.18"
                  fontFamily="JetBrains Mono, monospace"
                  fill={isSelected ? '#0284c7' : '#334155'}
                  fontWeight="600"
                  paintOrder="stroke"
                  stroke="#ffffff"
                  strokeWidth="0.08"
                  strokeLinejoin="round"
                >
                  {isEq ? 'EQ' : dim.text}
                </text>

                {/* Interactive Padlock Icon (only on selection or active lock) */}
                {showBadges && (
                  <g
                    transform={`translate(${mx + 0.8}, ${my + 0.10}) scale(1, -1)`}
                    className="cursor-pointer"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (dimConstraint) {
                        toggleConstraintLock(dimConstraint.id, !isLocked);
                      } else {
                        lockDimension(dim.guid, dim.guid, dim.length);
                      }
                    }}
                  >
                    <circle cx="0" cy="0" r="0.14" fill={isLocked ? '#0284c7' : '#e2e8f0'} stroke="#0284c7" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
                    <rect x="-0.06" y="-0.05" width="0.12" height="0.10" rx="0.02" fill={isLocked ? '#ffffff' : '#475569'} />
                    <path
                      d={isLocked ? "M -0.04 -0.05 A 0.04 0.04 0 0 1 0.04 -0.05" : "M -0.04 -0.05 A 0.04 0.04 0 0 1 0.04 -0.09"}
                      stroke={isLocked ? '#ffffff' : '#475569'}
                      strokeWidth="1.5"
                      vectorEffect="non-scaling-stroke"
                      fill="none"
                    />
                  </g>
                )}

                {/* Interactive EQ Toggle Pill (only on selection or active EQ) */}
                {showBadges && (
                  <g
                    transform={`translate(${mx - 0.8}, ${my + 0.10}) scale(1, -1)`}
                    className="cursor-pointer"
                    onClick={(e) => {
                      e.stopPropagation();
                      equalizeSouthWallWindows();
                    }}
                  >
                    <rect
                      x="-0.20"
                      y="-0.10"
                      width="0.40"
                      height="0.20"
                      rx="0.04"
                      fill={isEq ? '#0284c7' : '#ffffff'}
                      stroke="#0284c7"
                      strokeWidth="1.5"
                      vectorEffect="non-scaling-stroke"
                    />
                    <text
                      x="0"
                      y="0.05"
                      textAnchor="middle"
                      fontSize="0.13"
                      fontFamily="Inter, sans-serif"
                      fontWeight="bold"
                      fill={isEq ? '#ffffff' : '#0284c7'}
                    >
                      EQ
                    </text>
                  </g>
                )}
              </g>
            );
          })}

          {/* 7. Active Alignment Constraints Visual Lines with Padlocks */}
          {constraints
            .filter((c) => c.type === 'align')
            .map((c) => {
              const elemA = c.guid_a ? elements[c.guid_a] : undefined;
              const elemB = c.guid_b ? elements[c.guid_b] : undefined;
              if (!elemA && !elemB) return null;
              const posA = elemA?.start || [0, 0];
              const posB = elemB?.start || posA;
              const mx = (posA[0] + posB[0]) / 2;
              const my = (posA[1] + posB[1]) / 2;
              const isX = c.axis === 'x';
              const x1 = isX ? mx : Math.min(posA[0], posB[0]) - 2;
              const x2 = isX ? mx : Math.max(posA[0], posB[0]) + 2;
              const y1 = isX ? Math.min(posA[1], posB[1]) - 2 : my;
              const y2 = isX ? Math.max(posA[1], posB[1]) + 2 : my;
              return (
                <g key={`align-${c.id}`}>
                  {/* Alignment guide line */}
                  <line
                    x1={x1}
                    y1={y1}
                    x2={x2}
                    y2={y2}
                    stroke="#38bdf8"
                    strokeWidth="1.5"
                    vectorEffect="non-scaling-stroke"
                    strokeDasharray="6 3"
                  />
                  {/* Alignment Padlock */}
                  <g
                    transform={`translate(${mx}, ${my}) scale(1, -1)`}
                    className="cursor-pointer"
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleConstraintLock(c.id, !c.is_locked);
                    }}
                  >
                    <circle
                      cx="0"
                      cy="0"
                      r="0.22"
                      fill={c.is_locked ? '#0284c7' : '#ffffff'}
                      stroke="#0284c7"
                      strokeWidth="1.5"
                      vectorEffect="non-scaling-stroke"
                    />
                    <rect
                      x="-0.08"
                      y="-0.07"
                      width="0.16"
                      height="0.14"
                      rx="0.02"
                      fill={c.is_locked ? '#ffffff' : '#0284c7'}
                    />
                    <path
                      d="M -0.05 -0.07 A 0.05 0.05 0 0 1 0.05 -0.07"
                      stroke={c.is_locked ? '#ffffff' : '#0284c7'}
                      strokeWidth="1.5"
                      vectorEffect="non-scaling-stroke"
                      fill="none"
                    />
                  </g>
                </g>
              );
            })}
          </g>

          {/* Revit Sketch Mode Linework & Overlay */}
          {sketchSession && (
            <g id="sketch-mode-layer">
              {/* Existing Sketch Boundary Lines (Magenta #ec4899) */}
              {sketchSession.lines.map((l) => {
                const isSelected = sketchSession.selectedLineId === l.id;
                const midX = (l.start[0] + l.end[0]) / 2;
                const midY = (l.start[1] + l.end[1]) / 2;
                const dx = l.end[0] - l.start[0];
                const dy = l.end[1] - l.start[1];
                const len = Math.hypot(dx, dy);
                const nx = len > 0.0001 ? -dy / len : 0;
                const ny = len > 0.0001 ? dx / len : 0;

                return (
                  <g key={l.id} className="cursor-pointer">
                    {/* Transparent hit target for easy picking */}
                    <line
                      x1={l.start[0]}
                      y1={l.start[1]}
                      x2={l.end[0]}
                      y2={l.end[1]}
                      stroke="transparent"
                      strokeWidth="12"
                      vectorEffect="non-scaling-stroke"
                      onClick={(e) => {
                        e.stopPropagation();
                        selectSketchLine(l.id);
                      }}
                    />
                    {/* Revit-style Magenta Line */}
                    <line
                      x1={l.start[0]}
                      y1={l.start[1]}
                      x2={l.end[0]}
                      y2={l.end[1]}
                      stroke={isSelected ? '#be185d' : '#ec4899'}
                      strokeWidth={isSelected ? '3.5' : '2.5'}
                      vectorEffect="non-scaling-stroke"
                      strokeLinecap="round"
                      onClick={(e) => {
                        e.stopPropagation();
                        selectSketchLine(l.id);
                      }}
                    />
                    {/* Vertex Endpoints */}
                    <circle
                      cx={l.start[0]}
                      cy={l.start[1]}
                      r="0.10"
                      fill={isSelected ? '#be185d' : '#ec4899'}
                      stroke="#ffffff"
                      strokeWidth="1.5"
                      vectorEffect="non-scaling-stroke"
                    />
                    <circle
                      cx={l.end[0]}
                      cy={l.end[1]}
                      r="0.10"
                      fill={isSelected ? '#be185d' : '#ec4899'}
                      stroke="#ffffff"
                      strokeWidth="1.5"
                      vectorEffect="non-scaling-stroke"
                    />

                    {/* Roof Slope Indicator Triangle & Pitch Angle (Revit LT style) */}
                    {sketchSession.elementType === 'roof' && l.definesSlope && (
                      <g
                        transform={`translate(${midX}, ${midY})`}
                        className="pointer-events-none select-none"
                      >
                        <polygon
                          points={`${nx * 0.35},${ny * 0.35} ${-ny * 0.2},${nx * 0.2} ${ny * 0.2},${-nx * 0.2}`}
                          fill="#ec4899"
                          stroke="#ffffff"
                          strokeWidth="0.8"
                          vectorEffect="non-scaling-stroke"
                        />
                        <text
                          x={nx * 0.65}
                          y={-(ny * 0.65)}
                          transform="scale(1, -1)"
                          textAnchor="middle"
                          dominantBaseline="central"
                          fontSize="0.20"
                          fontFamily="JetBrains Mono, monospace"
                          fontWeight="bold"
                          fill="#be185d"
                          paintOrder="stroke"
                          stroke="#ffffff"
                          strokeWidth="0.06"
                        >
                          {`${(l.slopeAngle ?? sketchSession.slopeDegrees).toFixed(1)}°`}
                        </text>
                      </g>
                    )}
                  </g>
                );
              })}

              {/* Rubberband during Sketch Creation */}
              {sketchStartPoint && currentPoint && (
                <g className="pointer-events-none select-none">
                  {sketchSession.drawTool === 'line' && (
                    <>
                      <line
                        x1={sketchStartPoint[0]}
                        y1={sketchStartPoint[1]}
                        x2={currentPoint[0]}
                        y2={currentPoint[1]}
                        stroke="#ec4899"
                        strokeWidth="2.5"
                        strokeDasharray="5 3"
                        vectorEffect="non-scaling-stroke"
                      />
                      <circle
                        cx={sketchStartPoint[0]}
                        cy={sketchStartPoint[1]}
                        r="0.12"
                        fill="#ec4899"
                        stroke="#ffffff"
                        strokeWidth="1.5"
                        vectorEffect="non-scaling-stroke"
                      />
                      <circle
                        cx={currentPoint[0]}
                        cy={currentPoint[1]}
                        r="0.12"
                        fill="#f472b6"
                        stroke="#ffffff"
                        strokeWidth="1.5"
                        vectorEffect="non-scaling-stroke"
                      />
                      <text
                        x={(sketchStartPoint[0] + currentPoint[0]) / 2}
                        y={-((sketchStartPoint[1] + currentPoint[1]) / 2) - 0.25}
                        transform="scale(1, -1)"
                        textAnchor="middle"
                        fontSize="0.22"
                        fontFamily="JetBrains Mono, monospace"
                        fontWeight="bold"
                        fill="#ec4899"
                        paintOrder="stroke"
                        stroke="#ffffff"
                        strokeWidth="0.08"
                      >
                        {`${Math.hypot(
                          currentPoint[0] - sketchStartPoint[0],
                          currentPoint[1] - sketchStartPoint[1]
                        ).toFixed(2)}m (${(
                          Math.hypot(
                            currentPoint[0] - sketchStartPoint[0],
                            currentPoint[1] - sketchStartPoint[1]
                          ) * 3.28084
                        ).toFixed(1)}')`}
                      </text>
                    </>
                  )}

                  {sketchSession.drawTool === 'rectangle' && (
                    <>
                      <rect
                        x={Math.min(sketchStartPoint[0], currentPoint[0])}
                        y={Math.min(sketchStartPoint[1], currentPoint[1])}
                        width={Math.abs(currentPoint[0] - sketchStartPoint[0])}
                        height={Math.abs(currentPoint[1] - sketchStartPoint[1])}
                        stroke="#ec4899"
                        strokeWidth="2.5"
                        strokeDasharray="5 3"
                        vectorEffect="non-scaling-stroke"
                        fill="#fbcfe8"
                        fillOpacity="0.25"
                      />
                      <text
                        x={(sketchStartPoint[0] + currentPoint[0]) / 2}
                        y={-((sketchStartPoint[1] + currentPoint[1]) / 2)}
                        transform="scale(1, -1)"
                        textAnchor="middle"
                        fontSize="0.24"
                        fontFamily="JetBrains Mono, monospace"
                        fontWeight="bold"
                        fill="#ec4899"
                        paintOrder="stroke"
                        stroke="#ffffff"
                        strokeWidth="0.08"
                      >
                        {`${Math.abs(currentPoint[0] - sketchStartPoint[0]).toFixed(2)}m × ${Math.abs(
                          currentPoint[1] - sketchStartPoint[1]
                        ).toFixed(2)}m`}
                      </text>
                    </>
                  )}
                </g>
              )}

              {/* Snap Point Indicator */}
              {currentPoint && (() => {
                const snap = findSnapVertex(currentPoint);
                if (!snap) return null;
                return (
                  <g className="pointer-events-none select-none">
                    <circle
                      cx={snap[0]}
                      cy={snap[1]}
                      r="0.18"
                      fill="none"
                      stroke="#ec4899"
                      strokeWidth="2"
                      vectorEffect="non-scaling-stroke"
                      className="animate-ping"
                    />
                    <circle
                      cx={snap[0]}
                      cy={snap[1]}
                      r="0.14"
                      fill="#ec4899"
                      stroke="#ffffff"
                      strokeWidth="1.5"
                      vectorEffect="non-scaling-stroke"
                    />
                    <text
                      x={snap[0]}
                      y={-snap[1] - 0.28}
                      transform="scale(1, -1)"
                      textAnchor="middle"
                      fontSize="0.18"
                      fontFamily="Inter, sans-serif"
                      fontWeight="bold"
                      fill="#be185d"
                      paintOrder="stroke"
                      stroke="#ffffff"
                      strokeWidth="0.06"
                    >
                      Endpoint Snap
                    </text>
                  </g>
                );
              })()}
            </g>
          )}

          {/* Standard Live Drawing Rubberband Visuals (Walls) */}
          {firstPoint && currentPoint && (
            <g className="pointer-events-none select-none">
              {activeTool === 'WA' && (
                <>
                  <line
                    x1={firstPoint[0]}
                    y1={firstPoint[1]}
                    x2={currentPoint[0]}
                    y2={currentPoint[1]}
                    stroke="#0284c7"
                    strokeWidth="3.0"
                    vectorEffect="non-scaling-stroke"
                    strokeDasharray="6 3"
                  />
                  <circle cx={firstPoint[0]} cy={firstPoint[1]} r="0.14" fill="#0284c7" />
                  <circle cx={currentPoint[0]} cy={currentPoint[1]} r="0.14" fill="#38bdf8" />
                  <text
                    x={(firstPoint[0] + currentPoint[0]) / 2}
                    y={-((firstPoint[1] + currentPoint[1]) / 2) - 0.25}
                    transform="scale(1, -1)"
                    textAnchor="middle"
                    fontSize="0.24"
                    fontFamily="JetBrains Mono, monospace"
                    fontWeight="bold"
                    fill="#0284c7"
                    paintOrder="stroke"
                    stroke="#ffffff"
                    strokeWidth="0.08"
                  >
                    {`${Math.hypot(currentPoint[0] - firstPoint[0], currentPoint[1] - firstPoint[1]).toFixed(2)}m (${(
                      Math.hypot(currentPoint[0] - firstPoint[0], currentPoint[1] - firstPoint[1]) * 3.28084
                    ).toFixed(1)}')`}
                  </text>
                </>
              )}
            </g>
          )}
        </g>
      </svg>

      {/* Viewport Header Controls */}
      {(() => {
        const currentView = views.find((v) => v.id === activeViewId) || {
          name: 'Floor Plan: Level 1',
          viewRange: { cut: 1.2 },
        };
        return (
          <div className="absolute top-3 left-3 flex items-center space-x-2 bg-white/90 backdrop-blur px-3 py-1.5 rounded shadow border border-slate-300 text-xs text-slate-800 z-10 font-sans">
            <span className="font-bold">
              {currentView.name} (Cut Plane: {(currentView.viewRange.cut * 3.28084).toFixed(0)}'-0" / {currentView.viewRange.cut}m)
            </span>
            <span className="text-slate-400">|</span>
            <button
              onClick={resetView}
              className="p-1 hover:bg-slate-100 rounded text-slate-700"
              title="Zoom Extents"
            >
              <Maximize2 size={13} />
            </button>
          </div>
        );
      })()}

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
              title="Click to edit temporary dimension"
            >
              {tempDimension.displayValue}
            </span>
          )}
        </div>
      )}

      {/* Align Tool Active Banner */}
      {/* Align Tool Active Banner */}
      {!sketchSession && activeTool === 'AL' && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-[#094771]/95 text-white px-4 py-2 rounded-lg border border-[#38bdf8] text-xs shadow-xl flex items-center space-x-3 z-30 animate-fade-in">
          <Lock size={15} className="text-[#38bdf8] animate-pulse" />
          <span className="font-medium">
            {!alignPickState.refGuid
              ? 'ALIGN (AL): Pick reference edge or element (Grid / Wall)'
              : 'Reference picked. Now pick target element to align & lock.'}
          </span>
          <button
            onClick={() => {
              setActiveTool('select');
              setAlignPickState({ step: null, refGuid: null });
            }}
            className="px-2 py-0.5 bg-black/40 hover:bg-black/60 rounded text-[10px]"
          >
            Cancel (Esc)
          </button>
        </div>
      )}

      {/* Revit Sketch Mode Active Banner */}
      {sketchSession && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-[#064e3b]/95 text-white px-5 py-2.5 rounded-xl border border-emerald-500 text-xs shadow-2xl flex items-center space-x-4 z-30 animate-fade-in backdrop-blur-md">
          <div className="flex items-center space-x-2">
            <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse" />
            <span className="font-bold tracking-wide text-emerald-200 uppercase text-[11px]">
              {sketchSession.isEditingExisting ? 'Edit Mode' : 'Create Mode'}
            </span>
            <span className="text-slate-300 font-medium">
              {sketchSession.elementType === 'floor' ? 'Floor Boundary' : 'Roof Footprint'}
            </span>
          </div>
          <span className="text-emerald-300/40">|</span>
          <span className="text-slate-200 font-sans">
            {sketchSession.lines.length === 0
              ? 'Draw boundary lines to form a closed loop (hotkeys: LI = Line, RE = Rectangle, PW = Pick Walls)'
              : `${sketchSession.lines.length} sketch line${sketchSession.lines.length > 1 ? 's' : ''} defined.`}
          </span>
          <div className="flex items-center space-x-2 pl-2">
            <button
              onClick={() => finishSketchMode()}
              className="flex items-center space-x-1 px-3 py-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded font-semibold text-xs transition-colors shadow"
              title="Finish Edit Mode (Enter)"
            >
              <Check size={14} />
              <span>Finish</span>
            </button>
            <button
              onClick={() => cancelSketchMode()}
              className="flex items-center space-x-1 px-2.5 py-1 bg-red-600/80 hover:bg-red-600 text-white rounded font-medium text-xs transition-colors"
              title="Cancel Edit Mode (Esc)"
            >
              <X size={14} />
              <span>Cancel</span>
            </button>
          </div>
        </div>
      )}

      {/* Drawing Tool Active Banner */}
      {!sketchSession && activeTool !== 'select' && activeTool !== 'AL' && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-[#094771]/95 text-white px-4 py-2 rounded-lg border border-[#38bdf8] text-xs shadow-xl flex items-center space-x-3 z-30 animate-fade-in">
          <span className="w-2.5 h-2.5 rounded-full bg-sky-400 animate-ping" />
          <span className="font-medium">
            {activeTool === 'WA' && (!firstPoint ? 'WALL TOOL (WA): Click 1st point for wall baseline' : `Click 2nd point to place wall (${Math.hypot((currentPoint?.[0] || 0) - firstPoint[0], (currentPoint?.[1] || 0) - firstPoint[1]).toFixed(2)}m)`)}
            {activeTool === 'RF' && (!firstPoint ? 'ROOF TOOL (RF): Click 1st corner for roof footprint' : `Click opposite corner to place pitched roof (${Math.abs((currentPoint?.[0] || 0) - firstPoint[0]).toFixed(1)}m × ${Math.abs((currentPoint?.[1] || 0) - firstPoint[1]).toFixed(1)}m)`)}
            {activeTool === 'SB' && (!firstPoint ? 'FLOOR SLAB TOOL (SB): Click 1st corner for floor slab' : `Click opposite corner to place floor slab (${Math.abs((currentPoint?.[0] || 0) - firstPoint[0]).toFixed(1)}m × ${Math.abs((currentPoint?.[1] || 0) - firstPoint[1]).toFixed(1)}m)`)}
            {activeTool === 'DR' && 'DOOR TOOL (DR): Click near any wall to place door'}
            {activeTool === 'WN' && 'WINDOW TOOL (WN): Click near any wall to place window'}
          </span>
          <button
            onClick={() => {
              setActiveTool('select');
              setFirstPoint(null);
              setCurrentPoint(null);
            }}
            className="px-2 py-0.5 bg-black/40 hover:bg-black/60 rounded text-[10px] text-slate-200"
          >
            Cancel (Esc)
          </button>
        </div>
      )}
    </div>
  );
};
