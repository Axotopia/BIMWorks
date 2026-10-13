import React, { useState, useRef, useCallback, useEffect } from 'react';
import { useBimStore } from '../../store/useBimStore';
import { Maximize2, ZoomIn, ZoomOut, Lock, Equal } from 'lucide-react';

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
  } = useBimStore();

  const handleElementClick = (guid: string) => {
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

  const [pan, setPan] = useState<{ x: number; y: number }>({ x: 300, y: 300 });
  const [scale, setScale] = useState<number>(38); // 38 pixels per meter
  const isPanningRef = useRef<boolean>(false);
  const startMouseRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  const [editingDimValue, setEditingDimValue] = useState<string>('');
  const [isEditingDim, setIsEditingDim] = useState<boolean>(false);

  // Pan with Middle Mouse Button (MMB) or Left Drag
  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button === 1 || e.button === 0) {
      isPanningRef.current = true;
      startMouseRef.current = { x: e.clientX, y: e.clientY };
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (isPanningRef.current) {
      const dx = e.clientX - startMouseRef.current.x;
      const dy = e.clientY - startMouseRef.current.y;
      startMouseRef.current = { x: e.clientX, y: e.clientY };
      setPan((p) => ({ x: p.x + dx, y: p.y + dy }));
    }
  };

  const handleMouseUp = () => {
    isPanningRef.current = false;
  };

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const factor = e.deltaY > 0 ? 0.9 : 1.1;
    setScale((s) => Math.max(10, Math.min(250, s * factor)));
  };

  const fit2DToExtents = useCallback(() => {
    if (!sliced2D) return;
    const allPaths = [...(sliced2D.cut_paths || []), ...(sliced2D.projection_paths || [])];
    if (allPaths.length === 0) {
      setPan({ x: 350, y: 320 });
      setScale(40);
      return;
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    allPaths.forEach((p) => {
      const nums = p.d.match(/-?\d+(\.\d+)?/g);
      if (nums) {
        for (let i = 0; i < nums.length - 1; i += 2) {
          const x = parseFloat(nums[i]);
          const y = parseFloat(nums[i + 1]);
          if (!isNaN(x) && !isNaN(y)) {
            minX = Math.min(minX, x);
            maxX = Math.max(maxX, x);
            minY = Math.min(minY, y);
            maxY = Math.max(maxY, y);
          }
        }
      }
    });
    if (minX !== Infinity) {
      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;
      const w = Math.max(maxX - minX, 2);
      const h = Math.max(maxY - minY, 2);
      const containerW = 800;
      const containerH = 600;
      const fitScale = Math.min(containerW / (w * 1.4), containerH / (h * 1.4));
      const newScale = Math.max(5, Math.min(100, fitScale));
      setScale(newScale);
      setPan({
        x: containerW / 2 - cx * newScale,
        y: containerH / 2 + cy * newScale,
      });
    }
  }, [sliced2D]);

  const resetView = fit2DToExtents;

  useEffect(() => {
    if (sliced2D && (sliced2D.cut_paths?.length || sliced2D.projection_paths?.length)) {
      fit2DToExtents();
    }
  }, [sliced2D, fit2DToExtents]);

  return (
    <div
      className="relative w-full h-full bg-[#ffffff] overflow-hidden select-none cursor-grab active:cursor-grabbing"
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onWheel={handleWheel}
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
          {/* 1. Slabs in Projection */}
          {sliced2D?.slabs.map((slab) => (
            <path
              key={`slab-${slab.guid}`}
              d={slab.d}
              className={slab.class}
              stroke="#cbd5e1"
              strokeWidth="0.05"
              fill="#f8fafc"
            />
          ))}

          {/* 2. Datum Grids */}
          {sliced2D?.grids.map((grid) => (
            <g key={`grid-${grid.guid}`}>
              <path
                d={grid.d}
                stroke="#64748b"
                strokeWidth="0.04"
                strokeDasharray="0.3, 0.15, 0.05, 0.15"
              />
              {/* Grid Bubble Circle */}
              <circle
                cx={grid.circle_center[0]}
                cy={grid.circle_center[1]}
                r="0.5"
                fill="#ffffff"
                stroke="#0f172a"
                strokeWidth="0.05"
              />
              {/* Inverted text scale to render right-side up */}
              <text
                x={grid.circle_center[0]}
                y={-grid.circle_center[1]}
                transform="scale(1, -1)"
                textAnchor="middle"
                dominantBaseline="central"
                fontSize="0.45"
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
                strokeWidth={isSelected ? '0.08' : '0.06'}
                fill={isSelected ? '#bae6fd' : p.fill || '#e2e8f0'}
                onClick={(e) => {
                  e.stopPropagation();
                  handleElementClick(p.guid);
                }}
                className={`${p.class} cursor-pointer transition-colors`}
              />
            );
          })}

          {/* 4. Projections (Sills, Jambs) */}
          {sliced2D?.projection_paths.map((p, idx) => (
            <path
              key={`proj-${idx}`}
              d={p.d}
              className={p.class}
              stroke="#334155"
              strokeWidth="0.03"
              fill="none"
            />
          ))}

          {/* 5. Door Swings */}
          {sliced2D?.swing_paths.map((p, idx) => (
            <path
              key={`swing-${idx}`}
              d={p.d}
              className={p.class}
              stroke="#2563eb"
              strokeWidth="0.025"
              fill="none"
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
                  strokeWidth="0.015"
                />
                <line
                  x1={dim.end[0]}
                  y1={dim.end[1]}
                  x2={dim.end[0] + dx * 1.15}
                  y2={dim.end[1] + dy * 1.15}
                  stroke="#94a3b8"
                  strokeWidth="0.015"
                />

                {/* Dimension line */}
                <line
                  x1={dim.start[0] + dx}
                  y1={dim.start[1] + dy}
                  x2={dim.end[0] + dx}
                  y2={dim.end[1] + dy}
                  stroke={isSelected ? '#0284c7' : '#64748b'}
                  strokeWidth="0.02"
                />

                {/* Dimension Text */}
                <text
                  x={mx}
                  y={-my - 0.10}
                  transform="scale(1, -1)"
                  textAnchor="middle"
                  fontSize="0.22"
                  fontFamily="JetBrains Mono, monospace"
                  fill={isSelected ? '#0284c7' : '#334155'}
                  fontWeight="600"
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
                    <circle cx="0" cy="0" r="0.14" fill={isLocked ? '#0284c7' : '#e2e8f0'} stroke="#0284c7" strokeWidth="0.02" />
                    <rect x="-0.06" y="-0.05" width="0.12" height="0.10" rx="0.02" fill={isLocked ? '#ffffff' : '#475569'} />
                    <path
                      d={isLocked ? "M -0.04 -0.05 A 0.04 0.04 0 0 1 0.04 -0.05" : "M -0.04 -0.05 A 0.04 0.04 0 0 1 0.04 -0.09"}
                      stroke={isLocked ? '#ffffff' : '#475569'}
                      strokeWidth="0.02"
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
                      strokeWidth="0.02"
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
              return (
                <g key={`align-${c.id}`}>
                  {/* Alignment guide line */}
                  <line
                    x1="-5"
                    y1="0"
                    x2="18"
                    y2="0"
                    stroke="#38bdf8"
                    strokeWidth="0.03"
                    strokeDasharray="0.3, 0.2"
                  />
                  {/* Alignment Padlock */}
                  <g
                    transform="translate(6, 0.4) scale(1, -1)"
                    className="cursor-pointer"
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleConstraintLock(c.id, !c.is_locked);
                    }}
                  >
                    <circle
                      cx="0"
                      cy="0"
                      r="0.25"
                      fill={c.is_locked ? '#0284c7' : '#ffffff'}
                      stroke="#0284c7"
                      strokeWidth="0.03"
                    />
                    <rect
                      x="-0.10"
                      y="-0.09"
                      width="0.20"
                      height="0.18"
                      rx="0.02"
                      fill={c.is_locked ? '#ffffff' : '#0284c7'}
                    />
                    <path
                      d="M -0.07 -0.09 A 0.07 0.07 0 0 1 0.07 -0.09"
                      stroke={c.is_locked ? '#ffffff' : '#0284c7'}
                      strokeWidth="0.03"
                      fill="none"
                    />
                  </g>
                </g>
              );
            })}
        </g>
      </svg>

      {/* Viewport Header Controls */}
      <div className="absolute top-3 left-3 flex items-center space-x-2 bg-white/90 backdrop-blur px-3 py-1.5 rounded shadow border border-slate-300 text-xs text-slate-800 z-10 font-sans">
        <span className="font-bold">Floor Plan: Level 1 (Cut Plane: 4'-0" / 1.2m)</span>
        <span className="text-slate-400">|</span>
        <button
          onClick={resetView}
          className="p-1 hover:bg-slate-100 rounded text-slate-700"
          title="Zoom Extents"
        >
          <Maximize2 size={13} />
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
              title="Click to edit temporary dimension"
            >
              {tempDimension.displayValue}
            </span>
          )}
        </div>
      )}

      {/* Align Tool Active Banner */}
      {activeTool === 'AL' && (
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
    </div>
  );
};
