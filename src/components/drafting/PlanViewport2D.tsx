import React, { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { useBimStore, ZOOM_EXTENTS_EVENT } from '../../store/useBimStore';
import { formatLength, tryParseLength } from '../../utils/units';
import { BimElement, MeshBufferData } from '../../types/bim';
import { Maximize2, ZoomIn, ZoomOut, Lock, Equal, Check, X, Crosshair } from 'lucide-react';
import { ContextMenu } from '../common/ContextMenu';
import {
  findSnapCandidate,
  SnapCandidate,
  SnapSegment,
  isBoxInside,
  isBoxCrossing,
  BoundingBox2D,
  distToSegment,
} from '../../interaction/snapEngine';

// ---------------------------------------------------------------------------
// Alignment-guide geometry
//
// The overlay used to draw its dashed line at fixed coordinates (x -5..18,
// y 0) regardless of what was aligned — a fake presented as model data. These
// helpers derive the guide from the constrained elements' real extents so the
// line lands on the shared coordinate and the padlock sits on the line.
// ---------------------------------------------------------------------------

type XYBounds = { min: [number, number]; max: [number, number] };

function boundsFromElement(element: BimElement | undefined): XYBounds | null {
  if (!element) return null;
  const pts: Array<[number, number]> = [];
  if (element.start) pts.push([element.start[0], element.start[1]]);
  if (element.end) pts.push([element.end[0], element.end[1]]);
  if (element.polygon) pts.push(...element.polygon);

  // Openings carry no baseline, so fall back to the host wall's footprint.
  if (pts.length === 0 && element.host_wall_guid) return null;

  if (pts.length === 0) {
    const cx = element.start?.[0];
    return typeof cx === 'number' ? { min: [cx, 0], max: [cx, 0] } : null;
  }
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return { min: [Math.min(...xs), Math.min(...ys)], max: [Math.max(...xs), Math.max(...ys)] };
}

function boundsFromMesh(mesh: MeshBufferData | undefined): XYBounds | null {
  if (!mesh) return null;
  return { min: [mesh.bbox.min[0], mesh.bbox.min[1]], max: [mesh.bbox.max[0], mesh.bbox.max[1]] };
}

function unionBounds(a: XYBounds | null, b: XYBounds | null): XYBounds | null {
  if (!a) return b;
  if (!b) return a;
  return {
    min: [Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1])],
    max: [Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1])],
  };
}

function resolveBounds(
  guid: string | undefined,
  elements: Record<string, BimElement>,
  meshes: MeshBufferData[]
): XYBounds | null {
  if (!guid) return null;
  return (
    boundsFromElement(elements[guid]) ??
    boundsFromMesh(meshes.find((m) => m.guid === guid))
  );
}

/**
 * Position of an align-constraint guide: the shared coordinate along the
 * constrained axis, spanning both elements, with a padlock anchor.
 */
function alignmentGuide(
  c: { ref_guid?: string; target_guid?: string; axis?: 'x' | 'y' | 'z' },
  elements: Record<string, BimElement>,
  meshes: MeshBufferData[]
): { x1: number; y1: number; x2: number; y2: number; anchor: [number, number]; vertical: boolean } | null {
  const span = unionBounds(
    resolveBounds(c.ref_guid, elements, meshes),
    resolveBounds(c.target_guid, elements, meshes)
  );
  if (!span) return null;

  const axis = c.axis === 'y' ? 'y' : 'x';
  const pad = 0.75;

  if (axis === 'x') {
    // Shared X: a vertical guide from low Y to high Y.
    const guide = (span.min[0] + span.max[0]) / 2;
    return {
      x1: guide,
      y1: span.min[1] - pad,
      x2: guide,
      y2: span.max[1] + pad,
      anchor: [guide, (span.min[1] + span.max[1]) / 2],
      vertical: true,
    };
  }

  // Shared Y: a horizontal guide from low X to high X.
  const guide = (span.min[1] + span.max[1]) / 2;
  return {
    x1: span.min[0] - pad,
    y1: guide,
    x2: span.max[0] + pad,
    y2: guide,
    anchor: [(span.min[0] + span.max[0]) / 2, guide],
    vertical: false,
  };
}

export const PlanViewport2D: React.FC = () => {
  const {
    sliced2D,
    selectedGuid,
    setSelectedGuid,
    selectedGuids,
    setSelectedGuids,
    hoveredGuid,
    setHoveredGuid,
    setHoverCandidates,
    tempDimension,
    applyTemporaryDimensionChange,
    constraints,
    toggleConstraintLock,
    lockDimension,
    equalizeSouthWallWindows,
    setDimensionValue,
    createDimension,
    toggleDimensionLock,
    activeTool,
    alignPickState,
    setAlignPickState,
    trimPickState,
    setTrimPickState,
    trimExtendWall,
    splitWall,
    snapsEnabled,
    toggleSnaps,
    chainTools,
    createAlignConstraint,
    setActiveTool,
    elements,
    meshes,
    grids,
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
    interactionResetToken,
    displayUnit,
    setStatusMessage,
    projectName,
    levels,
    moveLevel,
    flipElementOrientation,
  } = useBimStore();

  const containerRef = useRef<HTMLDivElement>(null);

  const [firstPoint, setFirstPoint] = useState<[number, number] | null>(null);
  const [currentPoint, setCurrentPoint] = useState<[number, number] | null>(null);
  const [sketchStartPoint, setSketchStartPoint] = useState<[number, number] | null>(null);
  const [editingDimension, setEditingDimension] = useState<{ id: string; mx: number; my: number } | null>(null);
  const [dimInputVal, setDimInputVal] = useState<string>('');
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; guid: string | null } | null>(null);

  const [pan, setPan] = useState<{ x: number; y: number }>({ x: 300, y: 300 });
  // UI-P0-8: decimal feet, not metres — the engine's internal unit (spec §11.3).
  const [scale, setScale] = useState<number>(38); // pixels per foot
  const isPanningRef = useRef<boolean>(false);
  const startMouseRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  // Typed Snap State
  const [activeSnapCandidate, setActiveSnapCandidate] = useState<SnapCandidate | null>(null);

  // Window vs. Crossing Selection Box State
  const [selectionBox, setSelectionBox] = useState<{
    startX: number;
    startY: number;
    currX: number;
    currY: number;
    startClientX: number;
    startClientY: number;
  } | null>(null);

  // Memoized snap segments for SnapEngine
  const snapSegments = useMemo<SnapSegment[]>(() => {
    const segs: SnapSegment[] = [];
    if (sliced2D?.cut_paths) {
      for (const cp of sliced2D.cut_paths) {
        const el = elements[cp.guid];
        if (el?.start && el?.end) {
          segs.push({
            p1: [el.start[0], el.start[1]],
            p2: [el.end[0], el.end[1]],
            guid: cp.guid,
          });
        }
      }
    }
    if (sliced2D?.grids) {
      for (const g of sliced2D.grids) {
        const gridObj = grids.find((gr) => gr.guid === g.guid);
        if (gridObj) {
          segs.push({
            p1: [gridObj.start[0], gridObj.start[1]],
            p2: [gridObj.end[0], gridObj.end[1]],
            guid: g.guid,
          });
        }
      }
    }
    if (sketchSession) {
      for (const l of sketchSession.lines) {
        segs.push({ p1: l.start, p2: l.end, guid: l.id });
      }
    }
    return segs;
  }, [sliced2D, elements, grids, sketchSession]);

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

  /** Set while a placement mousedown is completing, so the click that follows the
   *  same gesture does not also re-select and re-derive a temporary dimension. */
  const placementGuidRef = useRef<string | null>(null);

  /**
   * UI-P0-15: a placement click used to fall through to `setSelectedGuid`, so
   * drawing a wall also re-selected something and recomputed a temporary
   * dimension, and inserting a door both inserted and selected it. Placement and
   * selection are different intents and must not run from one click.
   */
  const PLACEMENT_TOOLS = ['WA', 'DR', 'WN', 'RF', 'SB'];

  const getRawModelCoords = useCallback(
    (clientX: number, clientY: number): [number, number] | null => {
      if (!containerRef.current) return null;
      const rect = containerRef.current.getBoundingClientRect();
      const svgX = clientX - rect.left;
      const svgY = clientY - rect.top;
      const modelX = (svgX - pan.x) / scale;
      const modelY = -(svgY - pan.y) / scale;
      return [modelX, modelY];
    },
    [pan, scale]
  );

  const handleElementClick = async (guid: string, e?: React.MouseEvent) => {
    if (sketchSession) {
      if (sketchSession.drawTool === 'pick_walls') {
        const el = elements[guid];
        if (el?.ifc_class === 'IfcWallStandardCase' || el?.ifc_class === 'IfcWall') {
          addSketchFromWall(guid);
        }
      }
      return;
    }

    // A click that completed a placement is consumed by the placement.
    if (placementGuidRef.current === guid) {
      placementGuidRef.current = null;
      return;
    }
    if (PLACEMENT_TOOLS.includes(activeTool)) return;

    // ALIGN TOOL (AL)
    if (activeTool === 'AL') {
      if (!alignPickState.refGuid) {
        setAlignPickState({ step: 'pick_target', refGuid: guid });
      } else if (alignPickState.refGuid !== guid) {
        createAlignConstraint(alignPickState.refGuid, guid, 'x', true);
      } else {
        setStatusMessage('Pick a different element to align to the reference.');
      }
      return;
    }

    // TRIM / EXTEND TO CORNER TOOL (TR)
    if (activeTool === 'TR') {
      const clickPoint = (e && getRawModelCoords(e.clientX, e.clientY)) || currentPoint || [0, 0];
      if (!trimPickState.firstGuid) {
        setTrimPickState({ step: 'pick_second', firstGuid: guid, firstPoint: clickPoint });
        setStatusMessage('TRIM (TR): Pick second wall or datum line to form corner.');
      } else if (trimPickState.firstGuid !== guid) {
        const el1 = elements[trimPickState.firstGuid];
        const el2 = elements[guid];
        const pt1 = trimPickState.firstPoint || [0, 0];
        const pt2 = clickPoint;

        // End furthest from click point is the one moved to corner
        let endIdx1 = 1;
        if (el1?.start && el1?.end) {
          const d0 = Math.hypot(el1.start[0] - pt1[0], el1.start[1] - pt1[1]);
          const d1 = Math.hypot(el1.end[0] - pt1[0], el1.end[1] - pt1[1]);
          endIdx1 = d0 < d1 ? 1 : 0;
        }

        let endIdx2: number | undefined = undefined;
        if (el2?.start && el2?.end) {
          const d0 = Math.hypot(el2.start[0] - pt2[0], el2.start[1] - pt2[1]);
          const d1 = Math.hypot(el2.end[0] - pt2[0], el2.end[1] - pt2[1]);
          endIdx2 = d0 < d1 ? 1 : 0;
        }

        await trimExtendWall(trimPickState.firstGuid, endIdx1, guid, true, endIdx2);
      } else {
        setStatusMessage('Pick a different wall or datum line to complete trim.');
      }
      return;
    }

    // SPLIT ELEMENT TOOL (SL)
    if (activeTool === 'SL') {
      const el = elements[guid];
      if (el?.start && el?.end) {
        const pt = (e && getRawModelCoords(e.clientX, e.clientY)) || currentPoint || el.start;
        const sx = el.start[0], sy = el.start[1];
        const ex = el.end[0], ey = el.end[1];
        const len = Math.hypot(ex - sx, ey - sy);
        if (len > 0.1) {
          const ux = (ex - sx) / len, uy = (ey - sy) / len;
          const proj = (pt[0] - sx) * ux + (pt[1] - sy) * uy;
          const cutOffset = Math.max(0.1, Math.min(len - 0.1, proj));
          await splitWall(guid, cutOffset, 0.0);
        }
      }
      return;
    }

    // SPLIT WITH GAP TOOL (SO)
    if (activeTool === 'SO') {
      const el = elements[guid];
      if (el?.start && el?.end) {
        const pt = (e && getRawModelCoords(e.clientX, e.clientY)) || currentPoint || el.start;
        const sx = el.start[0], sy = el.start[1];
        const ex = el.end[0], ey = el.end[1];
        const len = Math.hypot(ex - sx, ey - sy);
        if (len > 0.5) {
          const ux = (ex - sx) / len, uy = (ey - sy) / len;
          const proj = (pt[0] - sx) * ux + (pt[1] - sy) * uy;
          const cutOffset = Math.max(0.25, Math.min(len - 0.25, proj));
          await splitWall(guid, cutOffset, 1.0);
        }
      }
      return;
    }

    // Standard SELECT tool (with Ctrl multi-select)
    if (e && (e.ctrlKey || e.metaKey)) {
      const next = selectedGuids.includes(guid)
        ? selectedGuids.filter((g) => g !== guid)
        : [...selectedGuids, guid];
      setSelectedGuids(next);
    } else {
      setSelectedGuid(guid);
    }
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

  const [editingDimValue, setEditingDimValue] = useState<string>('');
  const [isEditingDim, setIsEditingDim] = useState<boolean>(false);

  // Typed SnapEngine resolution (endpoint / midpoint / intersection / perpendicular / grid)
  const getModelCoords = useCallback(
    (clientX: number, clientY: number, forceOrtho = false): [number, number] | null => {
      const raw = getRawModelCoords(clientX, clientY);
      if (!raw) return null;
      if (!snapsEnabled) return raw;

      const activePt = sketchSession ? sketchStartPoint : firstPoint;
      const snap = findSnapCandidate(raw, {
        scale,
        pixelTolerance: 14,
        activePoint: activePt,
        segments: snapSegments,
        enableGridSnap: true,
        gridSize: 0.25,
        forceOrtho,
      });

      if (snap) {
        setActiveSnapCandidate(snap);
        return snap.point;
      }
      setActiveSnapCandidate(null);
      const snapGrid = 0.25;
      const snappedX = Math.round(raw[0] / snapGrid) * snapGrid;
      const snappedY = Math.round(raw[1] / snapGrid) * snapGrid;
      return [snappedX, snappedY];
    },
    [getRawModelCoords, snapsEnabled, scale, sketchSession, sketchStartPoint, firstPoint, snapSegments]
  );

  /**
   * UI-P0-10/UI-P0-11: this viewport used to run its own `Escape` listener in
   * parallel with the store's hotkey engine. The two disagreed: with a sketch line
   * selected, the store would only deselect the line (leaving the sketch session
   * alive) while this listener saw `activeTool === 'sketch'` and set `'select'` —
   * producing a live sketch session whose rubber band had frozen, because
   * `handleMouseMove` gated its preview update on `activeTool !== 'select'`.
   *
   * The store is now the single cancel path: it bumps `interactionResetToken` for
   * Escape, for a tool change and at the end of a sketch, and this is the only
   * place that clears the viewport's own in-progress points. `sketchStartPoint` is
   * included, which the old tool-change effect missed — a pending sketch point
   * survived cancel/finish and re-entered the next session as a phantom segment.
   */
  useEffect(() => {
    setFirstPoint(null);
    setCurrentPoint(null);
    setSketchStartPoint(null);
    setIsEditingDim(false);
    setActiveSnapCandidate(null);
    setSelectionBox(null);
    isPanningRef.current = false;
  }, [interactionResetToken, activeTool]);

  // Mouse interaction: Panning vs Geometry Authoring vs Box Selection
  const handleMouseDown = (e: React.MouseEvent) => {
    // MMB always pans, Alt+LMB also pans
    if (e.button === 1 || (e.button === 0 && e.altKey)) {
      isPanningRef.current = true;
      startMouseRef.current = { x: e.clientX, y: e.clientY };
      return;
    }

    // LMB
    if (e.button === 0) {
      if (activeTool === 'select') {
        const raw = getRawModelCoords(e.clientX, e.clientY);
        if (raw) {
          setSelectionBox({
            startX: raw[0],
            startY: raw[1],
            currX: raw[0],
            currY: raw[1],
            startClientX: e.clientX,
            startClientY: e.clientY,
          });
        }
        return;
      }

      const coords = getModelCoords(e.clientX, e.clientY, e.shiftKey);
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
          if (chainTools) {
            setFirstPoint([x, y]);
          } else {
            setFirstPoint(null);
            setCurrentPoint(null);
          }
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
          // UI-P0-15: remember which element this placement touched so the click
          // that follows this same mouse gesture does not also select it.
          placementGuidRef.current = nearestWallGuid;
          if (activeTool === 'DR') {
            createDoor(nearestWallGuid, hostOffset);
          } else {
            createWindow(nearestWallGuid, hostOffset);
          }
        } else {
          // The pick is silently dropped today; say why rather than doing nothing.
          setStatusMessage('No wall within reach — click on or near a wall to host the element.');
        }
      }
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    // UI-P0-13: a pan with no button held means the mouse-up was missed (released
    // off-canvas). Without this the plan kept panning on bare hover.
    if (isPanningRef.current && (e.buttons & 1) === 0 && (e.buttons & 4) === 0) {
      isPanningRef.current = false;
    }
    if (isPanningRef.current) {
      const dx = e.clientX - startMouseRef.current.x;
      const dy = e.clientY - startMouseRef.current.y;
      startMouseRef.current = { x: e.clientX, y: e.clientY };
      setPan((p) => ({ x: p.x + dx, y: p.y + dy }));
      return;
    }

    const rawCoords = getRawModelCoords(e.clientX, e.clientY);
    if (!rawCoords) return;

    if (selectionBox) {
      setSelectionBox((prev) => (prev ? { ...prev, currX: rawCoords[0], currY: rawCoords[1] } : null));
      return;
    }

    // Hover Candidates Tracking for Tab-cycling & Pre-highlighting
    const tol = 18 / scale;
    const candidates: string[] = [];
    if (sliced2D?.cut_paths) {
      for (const cp of sliced2D.cut_paths) {
        const el = elements[cp.guid];
        if (el?.start && el?.end) {
          const d = distToSegment(rawCoords, [el.start[0], el.start[1]], [el.end[0], el.end[1]]);
          if (d.distance <= tol) candidates.push(cp.guid);
        }
      }
    }
    if (sliced2D?.slabs) {
      for (const s of sliced2D.slabs) {
        const b = resolveBounds(s.guid, elements, meshes);
        if (b && rawCoords[0] >= b.min[0] - tol && rawCoords[0] <= b.max[0] + tol &&
               rawCoords[1] >= b.min[1] - tol && rawCoords[1] <= b.max[1] + tol) {
          candidates.push(s.guid);
        }
      }
    }
    if (sliced2D?.roofs) {
      for (const r of sliced2D.roofs) {
        const b = resolveBounds(r.guid, elements, meshes);
        if (b && rawCoords[0] >= b.min[0] - tol && rawCoords[0] <= b.max[0] + tol &&
               rawCoords[1] >= b.min[1] - tol && rawCoords[1] <= b.max[1] + tol) {
          candidates.push(r.guid);
        }
      }
    }
    if (sliced2D?.grids) {
      for (const g of sliced2D.grids) {
        if (Math.hypot(g.circle_center[0] - rawCoords[0], g.circle_center[1] - rawCoords[1]) <= tol * 2) {
          candidates.push(g.guid);
        }
      }
    }
    if (candidates.length > 0) {
      setHoverCandidates(candidates);
      if (!hoveredGuid || !candidates.includes(hoveredGuid)) {
        setHoveredGuid(candidates[0]);
      }
    } else {
      setHoverCandidates([]);
      if (hoveredGuid) setHoveredGuid(null);
    }

    if (activeTool !== 'select') {
      const coords = getModelCoords(e.clientX, e.clientY, e.shiftKey);
      if (coords) {
        setCurrentPoint(coords);
      }
    }
  };

  const handleMouseUp = (e: React.MouseEvent) => {
    isPanningRef.current = false;

    if (selectionBox) {
      const dist = Math.hypot(e.clientX - selectionBox.startClientX, e.clientY - selectionBox.startClientY);
      if (dist < 5) {
        // Click on empty canvas
        if (!e.ctrlKey && !e.metaKey) {
          setSelectedGuid(null);
          setSelectedGuids([]);
        }
      } else {
        const isCrossing = selectionBox.currX < selectionBox.startX;
        const selBox: BoundingBox2D = {
          minX: Math.min(selectionBox.startX, selectionBox.currX),
          maxX: Math.max(selectionBox.startX, selectionBox.currX),
          minY: Math.min(selectionBox.startY, selectionBox.currY),
          maxY: Math.max(selectionBox.startY, selectionBox.currY),
        };

        const hitGuids: string[] = [];

        sliced2D?.cut_paths?.forEach((cp) => {
          const b = resolveBounds(cp.guid, elements, meshes);
          if (!b) return;
          const targetBox: BoundingBox2D = { minX: b.min[0], minY: b.min[1], maxX: b.max[0], maxY: b.max[1] };
          if (isCrossing ? isBoxCrossing(targetBox, selBox) : isBoxInside(targetBox, selBox)) {
            hitGuids.push(cp.guid);
          }
        });

        sliced2D?.slabs?.forEach((sl) => {
          const b = resolveBounds(sl.guid, elements, meshes);
          if (!b) return;
          const targetBox: BoundingBox2D = { minX: b.min[0], minY: b.min[1], maxX: b.max[0], maxY: b.max[1] };
          if (isCrossing ? isBoxCrossing(targetBox, selBox) : isBoxInside(targetBox, selBox)) {
            hitGuids.push(sl.guid);
          }
        });

        sliced2D?.roofs?.forEach((rf) => {
          const b = resolveBounds(rf.guid, elements, meshes);
          if (!b) return;
          const targetBox: BoundingBox2D = { minX: b.min[0], minY: b.min[1], maxX: b.max[0], maxY: b.max[1] };
          if (isCrossing ? isBoxCrossing(targetBox, selBox) : isBoxInside(targetBox, selBox)) {
            hitGuids.push(rf.guid);
          }
        });

        sliced2D?.grids?.forEach((gr) => {
          const targetBox: BoundingBox2D = {
            minX: gr.circle_center[0] - 0.3,
            minY: gr.circle_center[1] - 0.3,
            maxX: gr.circle_center[0] + 0.3,
            maxY: gr.circle_center[1] + 0.3,
          };
          if (isCrossing ? isBoxCrossing(targetBox, selBox) : isBoxInside(targetBox, selBox)) {
            hitGuids.push(gr.guid);
          }
        });

        if (e.ctrlKey || e.metaKey) {
          const merged = Array.from(new Set([...selectedGuids, ...hitGuids]));
          setSelectedGuids(merged);
        } else {
          setSelectedGuids(hitGuids);
        }
      }
      setSelectionBox(null);
    }
  };

  /** A pointer that left the viewport must not leave a pan latched. */
  const handlePointerLeave = () => {
    isPanningRef.current = false;
  };

  /**
   * UI-P1-7 (part of UI-P0-6's event unification): zoom about the cursor.
   *
   * The React `onWheel` handler had two problems: `preventDefault()` is not
   * reliable from a React-attached wheel listener, so the page could scroll behind
   * the plan; and `pan` was never adjusted, so zooming was anchored to the
   * transform origin rather than to the point under the pointer. A native
   * non-passive listener on the container fixes both. Full zoom-to-cursor (keeping
   * the *model* point fixed) moves `pan` as well; see UI-P1-7.
   */
  const wheelScaleRef = useRef(scale);
  wheelScaleRef.current = scale;
  const panRef = useRef(pan);
  panRef.current = pan;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const rect = container.getBoundingClientRect();
      const cursorX = event.clientX - rect.left;
      const cursorY = event.clientY - rect.top;
      const factor = event.deltaY > 0 ? 0.9 : 1.1;
      const previous = wheelScaleRef.current;
      const next = Math.max(8, Math.min(250, previous * factor));
      if (next === previous) return;
      // Keep the model point under the cursor fixed.
      const modelX = (cursorX - panRef.current.x) / previous;
      const modelY = -(cursorY - panRef.current.y) / previous;
      setScale(next);
      setPan({ x: cursorX - modelX * next, y: cursorY + modelY * next });
    };
    container.addEventListener('wheel', onWheel, { passive: false });
    return () => container.removeEventListener('wheel', onWheel);
  }, []);

  const fit2DToExtents = useCallback(() => {
    if (!sliced2D) return;
    const pathsToFit: Array<{ d?: string }> = [
      ...(sliced2D.cut_paths || []),
      ...(sliced2D.projection_paths || []),
      ...(sliced2D.roofs || []),
      ...(sliced2D.slabs || []),
      ...(sliced2D.levels || []),
    ];

    if (pathsToFit.length === 0) {
      setPan({ x: 350, y: 320 });
      setScale(40);
      return;
    }

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    pathsToFit.forEach((p) => {
      if (!p.d) return;
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

  // UI-P0-6/UI-P0-28: `ZE` dispatches one shared event, and both viewports listen —
  // previously only the 3D viewport did, so Zoom Extents did nothing in a plan.
  useEffect(() => {
    const handleZoomExtents = () => fit2DToExtents();
    window.addEventListener(ZOOM_EXTENTS_EVENT, handleZoomExtents);
    return () => window.removeEventListener(ZOOM_EXTENTS_EVENT, handleZoomExtents);
  }, [fit2DToExtents]);

  /**
   * Track A5: Fit to extents on view switch and on first load with content.
   * Preserves user pan/zoom across edits within the same active view.
   */
  const lastFittedViewRef = useRef<string | null>(null);
  useEffect(() => {
    const hasContent = Boolean(
      sliced2D &&
        (sliced2D.cut_paths?.length ||
          sliced2D.projection_paths?.length ||
          sliced2D.roofs?.length ||
          sliced2D.slabs?.length ||
          sliced2D.levels?.length)
    );
    const viewKey = `${projectName}:${activeViewId}`;
    if (hasContent && lastFittedViewRef.current !== viewKey) {
      fit2DToExtents();
      lastFittedViewRef.current = viewKey;
    }
  }, [activeViewId, projectName, sliced2D, fit2DToExtents]);

  const isDrawing = activeTool !== 'select' && activeTool !== 'AL';

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const target = hoveredGuid || (selectedGuids.length > 0 ? selectedGuids[selectedGuids.length - 1] : selectedGuid);
    if (target && !selectedGuids.includes(target)) {
      setSelectedGuid(target);
    }
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      guid: target,
    });
  };

  return (
    <div
      ref={containerRef}
      className={`relative w-full h-full bg-[#ffffff] overflow-hidden select-none ${
        isDrawing ? 'cursor-crosshair' : 'cursor-grab active:cursor-grabbing'
      }`}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handlePointerLeave}
      onDoubleClick={handleDoubleClick}
      onContextMenu={handleContextMenu}
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
              const isSelected = selectedGuids.includes(slab.guid) || selectedGuid === slab.guid;
              const isHovered = hoveredGuid === slab.guid;
              return (
                <path
                  key={`slab-${slab.guid}`}
                  d={slab.d}
                  className={`${slab.class} cursor-pointer transition-colors`}
                  stroke={isSelected ? '#0284c7' : isHovered ? '#38bdf8' : '#94a3b8'}
                  strokeWidth={isSelected ? '2.5' : isHovered ? '2.0' : '0.8'}
                  vectorEffect="non-scaling-stroke"
                  fill={isSelected ? '#bae6fd' : isHovered ? '#e0f2fe' : '#f8fafc'}
                  fillOpacity={isSelected ? 0.5 : isHovered ? 0.45 : 0.4}
                  onMouseEnter={() => setHoveredGuid(slab.guid)}
                  onMouseLeave={() => setHoveredGuid(null)}
                  onClick={(e) => {
                    e.stopPropagation();
                    handleElementClick(slab.guid, e);
                  }}
                />
              );
            })}

          {/* 1b. Roofs in Projection (Boundary, Ridge, and Pitch Slope) */}
          {sliced2D?.roofs?.map((roof) => {
            if (sketchSession?.isEditingExisting && sketchSession.targetGuid === roof.guid) return null;
            const isSelected = selectedGuids.includes(roof.guid) || selectedGuid === roof.guid;
            const isHovered = hoveredGuid === roof.guid;
            return (
              <g
                key={`roof-${roof.guid}`}
                onMouseEnter={() => setHoveredGuid(roof.guid)}
                onMouseLeave={() => setHoveredGuid(null)}
                onClick={(e) => {
                  e.stopPropagation();
                  handleElementClick(roof.guid, e);
                }}
                className="cursor-pointer"
              >
                <path
                  d={roof.d}
                  stroke={isSelected ? '#0284c7' : isHovered ? '#38bdf8' : '#475569'}
                  strokeWidth={isSelected ? '2.5' : isHovered ? '2.2' : '1.5'}
                  strokeDasharray={roof.is_overhead ? '6 3' : 'none'}
                  vectorEffect="non-scaling-stroke"
                  fill={isSelected ? '#bae6fd' : isHovered ? '#e0f2fe' : '#e2e8f0'}
                  fillOpacity={isSelected ? 0.45 : isHovered ? 0.35 : 0.25}
                />
                {roof.ridge_d && (
                  <path
                    d={roof.ridge_d}
                    stroke={isSelected ? '#0284c7' : isHovered ? '#38bdf8' : '#334155'}
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
          {sliced2D?.grids.map((grid) => {
            const isSelected = selectedGuids.includes(grid.guid) || selectedGuid === grid.guid;
            const isHovered = hoveredGuid === grid.guid;
            return (
              <g
                key={`grid-${grid.guid}`}
                className="cursor-pointer group"
                onMouseEnter={() => setHoveredGuid(grid.guid)}
                onMouseLeave={() => setHoveredGuid(null)}
                onClick={(e) => {
                  e.stopPropagation();
                  handleElementClick(grid.guid, e);
                }}
              >
                <path
                  d={grid.d}
                  stroke={isSelected ? '#0284c7' : isHovered ? '#38bdf8' : '#64748b'}
                  strokeWidth={isSelected ? '2.0' : isHovered ? '1.8' : '1.2'}
                  vectorEffect="non-scaling-stroke"
                  strokeDasharray="8 4 2 4"
                />
                {/* Grid Bubble Circle */}
                <circle
                  cx={grid.circle_center[0]}
                  cy={grid.circle_center[1]}
                  r="0.26"
                  fill={isSelected ? '#bae6fd' : isHovered ? '#e0f2fe' : '#ffffff'}
                  stroke={isSelected ? '#0284c7' : isHovered ? '#38bdf8' : '#0f172a'}
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
            );
          })}

          {/* 2b. Datum Levels (Task 2.7) */}
          {sliced2D?.levels?.map((lvl) => {
            const isSelected = selectedGuids.includes(lvl.id) || selectedGuid === lvl.id;
            const isHovered = hoveredGuid === lvl.id;
            return (
              <g
                key={`level-${lvl.id}`}
                className="group select-none cursor-pointer"
                onMouseEnter={() => setHoveredGuid(lvl.id)}
                onMouseLeave={() => setHoveredGuid(null)}
                onClick={(e) => {
                  e.stopPropagation();
                  handleElementClick(lvl.id, e);
                }}
              >
                <path
                  d={lvl.d}
                  stroke={isSelected ? '#0284c7' : isHovered ? '#38bdf8' : '#64748b'}
                  strokeWidth={isSelected ? '2.0' : isHovered ? '1.8' : '1.2'}
                  vectorEffect="non-scaling-stroke"
                  strokeDasharray="8 4 2 4"
                />
                {/* Level Head Bubble */}
                <circle
                  cx={lvl.circle_center[0]}
                  cy={lvl.circle_center[1]}
                  r="0.30"
                  fill={isSelected ? '#bae6fd' : isHovered ? '#e0f2fe' : '#ffffff'}
                  stroke={isSelected ? '#0284c7' : isHovered ? '#38bdf8' : '#0284c7'}
                  strokeWidth="1.4"
                  vectorEffect="non-scaling-stroke"
                  className="cursor-pointer hover:fill-sky-100 transition-colors"
                />
                {/* Level Name Label */}
                <text
                  x={lvl.circle_center[0] + 0.45}
                  y={-lvl.circle_center[1] - 0.12}
                  transform="scale(1, -1)"
                  textAnchor="start"
                  dominantBaseline="central"
                  fontSize="0.22"
                  fontFamily="Inter, sans-serif"
                  fontWeight="bold"
                  fill="#0f172a"
                  paintOrder="stroke"
                  stroke="#ffffff"
                  strokeWidth="0.06"
                  strokeLinejoin="round"
                >
                  {lvl.name}
                </text>
                {/* Level Elevation Label (Clickable in-canvas to edit elevation via moveLevel) */}
                <text
                  x={lvl.circle_center[0] + 0.45}
                  y={-lvl.circle_center[1] + 0.14}
                  transform="scale(1, -1)"
                  textAnchor="start"
                  dominantBaseline="central"
                  fontSize="0.20"
                  fontFamily="JetBrains Mono, monospace"
                  fontWeight="600"
                  fill="#0284c7"
                  paintOrder="stroke"
                  stroke="#ffffff"
                  strokeWidth="0.06"
                  strokeLinejoin="round"
                  className="cursor-pointer hover:fill-sky-600 underline"
                  onClick={(e) => {
                    e.stopPropagation();
                    setEditingDimension({ id: lvl.id, mx: lvl.circle_center[0] + 0.8, my: lvl.circle_center[1] });
                    setDimInputVal(formatLength(lvl.elevation, displayUnit));
                  }}
                >
                  {lvl.elevation_text || formatLength(lvl.elevation, displayUnit)}
                </text>
              </g>
            );
          })}

          {/* 3. Cut Elements (Walls) */}
          {sliced2D?.cut_paths.map((p, idx) => {
            const isSelected = selectedGuids.includes(p.guid) || selectedGuid === p.guid;
            const isHovered = hoveredGuid === p.guid;
            return (
              <path
                key={`cut-${idx}`}
                d={p.d}
                stroke={isSelected ? '#0284c7' : isHovered ? '#38bdf8' : '#0f172a'}
                strokeWidth={isSelected ? '2.5' : isHovered ? '2.2' : '1.75'}
                vectorEffect="non-scaling-stroke"
                strokeLinejoin="round"
                strokeLinecap="round"
                fill={isSelected ? '#bae6fd' : isHovered ? '#e0f2fe' : '#cbd5e1'}
                onMouseEnter={() => setHoveredGuid(p.guid)}
                onMouseLeave={() => setHoveredGuid(null)}
                onClick={(e) => {
                  e.stopPropagation();
                  handleElementClick(p.guid, e);
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

          {/* 4b. Hidden lines: occluded geometry, separated by the HLR renderer.
              Dashed and light per drawing convention, and drawn before the cut so the
              heavy linework sits on top. */}
          {(sliced2D?.hidden_paths || []).map((p, idx) => (
            <path
              key={`hidden-${idx}`}
              d={p.d}
              className={p.class}
              stroke="#94a3b8"
              strokeWidth="0.8"
              strokeDasharray="4 3"
              vectorEffect="non-scaling-stroke"
              fill="none"
              style={{ fill: 'none' }}
            />
          ))}

          {/* 4c. Window symbols: jambs and glazing. Annotation, so a window reads as
              a window rather than a plain gap in the wall. */}
          {(sliced2D?.window_paths || []).map((p, idx) => (
            <path
              key={`window-${idx}`}
              d={p.d}
              className={p.class}
              stroke="#0e7490"
              strokeWidth="0.9"
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
            if (!dim.start || !dim.end || dim.status === 'lost') return null;
            const isSelected = selectedGuid === dim.guid;
            // `GeometricReference.guid` is optional (hint-only point references have none), so
            // narrow once here rather than relying on optional-chain narrowing at the call site.
            const refAGuid = dim.ref_a?.guid ?? null;
            const refBGuid = dim.ref_b?.guid ?? null;
            const offDist = 0.8;
            const offsetNorm = dim.offset_norm || [0, 1];
            const dx = offsetNorm[0] * offDist;
            const dy = offsetNorm[1] * offDist;
            const mx = (dim.start[0] + dim.end[0]) / 2 + dx;
            const my = (dim.start[1] + dim.end[1]) / 2 + dy;
            const dimDx = dim.end[0] - dim.start[0];
            const dimDy = dim.end[1] - dim.start[1];
            let deg = (Math.atan2(dimDy, dimDx) * 180) / Math.PI;
            if (deg > 90) deg -= 180;
            if (deg < -90) deg += 180;

            // Check if dimension is locked or equalized
            const dimConstraint = constraints.find(
              (c) =>
                c.type === 'dimension_lock' &&
                ((dim.guid && (c.guid_a === dim.guid || c.guid_b === dim.guid)) ||
                  (dim.id && (c as any).dimension_id === dim.id))
            );
            const isLocked = dim.is_locked || (dimConstraint ? dimConstraint.is_locked : false);
            const eqConstraint = constraints.find(
              (c) =>
                c.type === 'equalize' &&
                ((dim.guid &&
                  (c.interior_guids?.includes(dim.guid) ||
                    c.span_start_guid === dim.guid ||
                    c.span_end_guid === dim.guid)) ||
                  (dim.id && (c as any).dimension_id === dim.id))
            );
            const isEq = Boolean(eqConstraint?.is_equalized);
            const showBadges = isSelected || isLocked || isEq;

            return (
              <g key={dim.id || `dim-${idx}`} className="text-dimension select-none">
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

                {/* Dimension Text with readability halo, angle alignment & in-canvas click to edit */}
                <text
                  x={mx}
                  y={-my - 0.10}
                  transform={`scale(1, -1) ${Math.abs(deg) > 0.01 ? `rotate(${-deg}, ${mx}, ${-my - 0.10})` : ''}`}
                  textAnchor="middle"
                  fontSize="0.18"
                  fontFamily="JetBrains Mono, monospace"
                  fill={isSelected ? '#0284c7' : '#334155'}
                  fontWeight="600"
                  paintOrder="stroke"
                  stroke="#ffffff"
                  strokeWidth="0.08"
                  strokeLinejoin="round"
                  className="cursor-pointer hover:fill-sky-600 transition-colors"
                  onClick={(e) => {
                    e.stopPropagation();
                    const targetId = dim.id || dim.guid;
                    if (targetId) {
                      setEditingDimension({ id: targetId, mx, my });
                      setDimInputVal(formatLength(dim.length, displayUnit));
                    }
                  }}
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
                      if (dim.id) {
                        toggleDimensionLock(dim.id, !isLocked);
                      } else if (dimConstraint) {
                        toggleConstraintLock(dimConstraint.id, !isLocked);
                      } else if (refAGuid && refBGuid) {
                        lockDimension(refAGuid, refBGuid, dim.length, (dim.axis as any) || 'x');
                      } else if (dim.guid) {
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
                      if (eqConstraint) {
                        toggleConstraintLock(eqConstraint.id, !eqConstraint.is_locked);
                      } else {
                        equalizeSouthWallWindows();
                      }
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

          {/* 6b. In-Canvas Temporary Selection Dimension with Real Witness Lines (Task 2.8) */}
          {tempDimension && tempDimension.witnessP1 && tempDimension.witnessP2 && (
            (() => {
              const p1 = tempDimension.witnessP1;
              const p2 = tempDimension.witnessP2;
              const tDx = p2[0] - p1[0];
              const tDy = p2[1] - p1[1];
              const tLen = Math.hypot(tDx, tDy);
              if (tLen < 0.05) return null;
              const unx = -tDy / tLen;
              const uny = tDx / tLen;
              const off = 1.0;
              const ox = unx * off;
              const oy = uny * off;
              const tmx = (p1[0] + p2[0]) / 2 + ox;
              const tmy = (p1[1] + p2[1]) / 2 + oy;
              let tDeg = (Math.atan2(tDy, tDx) * 180) / Math.PI;
              if (tDeg > 90) tDeg -= 180;
              if (tDeg < -90) tDeg += 180;

              return (
                <g key="temp-dim-in-canvas" className="text-temp-dimension select-none">
                  {/* Witness Lines */}
                  <line
                    x1={p1[0]}
                    y1={p1[1]}
                    x2={p1[0] + ox * 1.15}
                    y2={p1[1] + oy * 1.15}
                    stroke="#0284c7"
                    strokeWidth="0.8"
                    vectorEffect="non-scaling-stroke"
                    strokeDasharray="2 2"
                  />
                  <line
                    x1={p2[0]}
                    y1={p2[1]}
                    x2={p2[0] + ox * 1.15}
                    y2={p2[1] + oy * 1.15}
                    stroke="#0284c7"
                    strokeWidth="0.8"
                    vectorEffect="non-scaling-stroke"
                    strokeDasharray="2 2"
                  />
                  {/* Dimension Line */}
                  <line
                    x1={p1[0] + ox}
                    y1={p1[1] + oy}
                    x2={p2[0] + ox}
                    y2={p2[1] + oy}
                    stroke="#0284c7"
                    strokeWidth="1.2"
                    vectorEffect="non-scaling-stroke"
                  />
                  {/* Dimension Text with in-canvas click to edit */}
                  <text
                    x={tmx}
                    y={-tmy - 0.10}
                    transform={`scale(1, -1) ${Math.abs(tDeg) > 0.01 ? `rotate(${-tDeg}, ${tmx}, ${-tmy - 0.10})` : ''}`}
                    textAnchor="middle"
                    fontSize="0.20"
                    fontFamily="JetBrains Mono, monospace"
                    fill="#0284c7"
                    fontWeight="700"
                    paintOrder="stroke"
                    stroke="#ffffff"
                    strokeWidth="0.08"
                    strokeLinejoin="round"
                    className="cursor-pointer hover:fill-sky-700 transition-colors"
                    onClick={(e) => {
                      e.stopPropagation();
                      setEditingDimension({ id: tempDimension.elementGuid, mx: tmx, my: tmy });
                      setDimInputVal(formatLength(tempDimension.distance, displayUnit));
                    }}
                  >
                    {tempDimension.displayValue}
                  </text>
                </g>
              );
            })()
          )}

          {/* 7. Active Alignment Constraints Visual Lines with Padlocks
                 Geometry comes from the constrained elements' real extents. */}
          {constraints
            .filter((c) => c.type === 'align')
            .map((c) => {
              // Guide geometry from the constrained elements' real extents.
              // NOTE: engine align constraints key on `ref_guid`/`target_guid`
              // (only dimension locks use `guid_a`/`guid_b`), so the lookup must
              // try both or align guides silently never render.
              const guide = alignmentGuide(
                {
                  ref_guid: c.ref_guid ?? c.guid_a,
                  target_guid: c.target_guid ?? c.guid_b,
                  axis: c.axis,
                },
                elements,
                meshes
              );
              if (!guide) return null;
              const [ax, ay] = guide.anchor;
              const perpendicularOffset = guide.vertical ? 0.35 : -0.35;
              return (
                <g key={`align-${c.id}`}>
                  {/* Alignment guide line at the shared coordinate */}
                  <line
                    x1={guide.x1}
                    y1={guide.y1}
                    x2={guide.x2}
                    y2={guide.y2}
                    stroke="#38bdf8"
                    strokeWidth="1.5"
                    vectorEffect="non-scaling-stroke"
                    strokeDasharray="6 3"
                  />
                  {/* Alignment Padlock, sitting on the guide line */}
                  <g transform={`translate(${ax}, ${ay}) scale(1, -1)`}>
                    <g
                      transform={`translate(0, ${perpendicularOffset})`}
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
                        strokeWidth="1.5"
                        vectorEffect="non-scaling-stroke"
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
                        strokeWidth="1.5"
                        vectorEffect="non-scaling-stroke"
                        fill="none"
                      />
                    </g>
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
                          {`${(l.slopeAngle ?? sketchSession.defaultSlopeAngle ?? sketchSession.pitch ?? 15.0).toFixed(1)}°`}
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
                        {/* UI-P0-2: this printed the same length twice — once with
                            a foot mark and once multiplied by 3.28084 and also
                            marked as feet — so a 12'-6" line read "12.50' (41.0')".
                            One value, in the user's display unit. */}
                        {formatLength(
                          Math.hypot(
                            currentPoint[0] - sketchStartPoint[0],
                            currentPoint[1] - sketchStartPoint[1]
                          ),
                          displayUnit
                        )}
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
                        {`${Math.abs(currentPoint[0] - sketchStartPoint[0]).toFixed(2)}' × ${Math.abs(
                          currentPoint[1] - sketchStartPoint[1]
                        ).toFixed(2)}'`}
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
                    {/* UI-P0-2: one value, in the user's display unit. */}
                    {formatLength(
                      Math.hypot(currentPoint[0] - firstPoint[0], currentPoint[1] - firstPoint[1]),
                      displayUnit
                    )}
                  </text>
                </>
              )}
            </g>
          )}

          {/* Window vs. Crossing Selection Box Overlay */}
          {selectionBox && Math.hypot(selectionBox.currX - selectionBox.startX, selectionBox.currY - selectionBox.startY) > 0.05 && (
            (() => {
              const isCrossing = selectionBox.currX < selectionBox.startX;
              const bx = Math.min(selectionBox.startX, selectionBox.currX);
              const by = Math.min(selectionBox.startY, selectionBox.currY);
              const bw = Math.abs(selectionBox.currX - selectionBox.startX);
              const bh = Math.abs(selectionBox.currY - selectionBox.startY);
              return (
                <rect
                  x={bx}
                  y={by}
                  width={bw}
                  height={bh}
                  fill={isCrossing ? 'rgba(74, 222, 128, 0.20)' : 'rgba(56, 189, 248, 0.20)'}
                  stroke={isCrossing ? '#16a34a' : '#0284c7'}
                  strokeWidth="1.5"
                  strokeDasharray={isCrossing ? '6 4' : 'none'}
                  vectorEffect="non-scaling-stroke"
                  className="pointer-events-none select-none"
                />
              );
            })()
          )}

          {/* Typed Snap Glyphs & Tooltip Overlay */}
          {activeSnapCandidate && (
            <g className="pointer-events-none select-none">
              {activeSnapCandidate.kind === 'endpoint' && (
                <rect
                  x={activeSnapCandidate.point[0] - 0.16}
                  y={activeSnapCandidate.point[1] - 0.16}
                  width="0.32"
                  height="0.32"
                  fill="none"
                  stroke="#0284c7"
                  strokeWidth="2.5"
                  vectorEffect="non-scaling-stroke"
                />
              )}
              {activeSnapCandidate.kind === 'midpoint' && (
                <polygon
                  points={`${activeSnapCandidate.point[0]},${activeSnapCandidate.point[1] + 0.18} ${activeSnapCandidate.point[0] - 0.18},${activeSnapCandidate.point[1] - 0.15} ${activeSnapCandidate.point[0] + 0.18},${activeSnapCandidate.point[1] - 0.15}`}
                  fill="none"
                  stroke="#0284c7"
                  strokeWidth="2.5"
                  vectorEffect="non-scaling-stroke"
                />
              )}
              {activeSnapCandidate.kind === 'intersection' && (
                <g>
                  <line
                    x1={activeSnapCandidate.point[0] - 0.18}
                    y1={activeSnapCandidate.point[1] - 0.18}
                    x2={activeSnapCandidate.point[0] + 0.18}
                    y2={activeSnapCandidate.point[1] + 0.18}
                    stroke="#0284c7"
                    strokeWidth="2.5"
                    vectorEffect="non-scaling-stroke"
                  />
                  <line
                    x1={activeSnapCandidate.point[0] - 0.18}
                    y1={activeSnapCandidate.point[1] + 0.18}
                    x2={activeSnapCandidate.point[0] + 0.18}
                    y2={activeSnapCandidate.point[1] - 0.18}
                    stroke="#0284c7"
                    strokeWidth="2.5"
                    vectorEffect="non-scaling-stroke"
                  />
                </g>
              )}
              {activeSnapCandidate.kind === 'perpendicular' && (
                <path
                  d={`M ${activeSnapCandidate.point[0]} ${activeSnapCandidate.point[1] + 0.20} L ${activeSnapCandidate.point[0]} ${activeSnapCandidate.point[1]} L ${activeSnapCandidate.point[0] + 0.20} ${activeSnapCandidate.point[1]}`}
                  fill="none"
                  stroke="#0284c7"
                  strokeWidth="2.5"
                  vectorEffect="non-scaling-stroke"
                />
              )}
              {activeSnapCandidate.kind === 'grid' && (
                <polygon
                  points={`${activeSnapCandidate.point[0]},${activeSnapCandidate.point[1] + 0.14} ${activeSnapCandidate.point[0] + 0.14},${activeSnapCandidate.point[1]} ${activeSnapCandidate.point[0]},${activeSnapCandidate.point[1] - 0.14} ${activeSnapCandidate.point[0] - 0.14},${activeSnapCandidate.point[1]}`}
                  fill="none"
                  stroke="#0284c7"
                  strokeWidth="2.0"
                  vectorEffect="non-scaling-stroke"
                />
              )}
              {/* Tooltip Label */}
              <text
                x={activeSnapCandidate.point[0] + 0.30}
                y={-activeSnapCandidate.point[1] - 0.25}
                transform="scale(1, -1)"
                textAnchor="start"
                dominantBaseline="central"
                fontSize="0.19"
                fontFamily="Inter, sans-serif"
                fontWeight="bold"
                fill="#0284c7"
                paintOrder="stroke"
                stroke="#ffffff"
                strokeWidth="0.08"
                strokeLinejoin="round"
              >
                {activeSnapCandidate.description}
              </text>
            </g>
          )}

          {/* Live Door / Window Modeless Placement Ghost Preview */}
          {(activeTool === 'DR' || activeTool === 'WN') && currentPoint && (() => {
            type HostWallHit = { guid: string; start: [number, number]; end: [number, number]; proj: number; dist: number };
            let nearestWall: HostWallHit | null = null;
            for (const cp of (sliced2D?.cut_paths || [])) {
              const el = elements[cp.guid];
              if (el?.start && el?.end) {
                const sx = el.start[0], sy = el.start[1];
                const ex = el.end[0], ey = el.end[1];
                const len = Math.hypot(ex - sx, ey - sy);
                if (len > 0.01) {
                  const ux = (ex - sx) / len, uy = (ey - sy) / len;
                  const p = (currentPoint[0] - sx) * ux + (currentPoint[1] - sy) * uy;
                  if (p >= 0 && p <= len) {
                    const perp = Math.hypot(currentPoint[0] - (sx + ux * p), currentPoint[1] - (sy + uy * p));
                    if (perp < 2.5 && (!nearestWall || perp < nearestWall.dist)) {
                      nearestWall = { guid: cp.guid, start: [sx, sy], end: [ex, ey], proj: p, dist: perp };
                    }
                  }
                }
              }
            }
            if (!nearestWall) return null;
            const nw: HostWallHit = nearestWall;
            const len = Math.hypot(nw.end[0] - nw.start[0], nw.end[1] - nw.start[1]);
            const ux = (nw.end[0] - nw.start[0]) / len;
            const uy = (nw.end[1] - nw.start[1]) / len;
            const hx = nw.start[0] + ux * nw.proj;
            const hy = nw.start[1] + uy * nw.proj;
            const openW = activeTool === 'DR' ? 3.0 : 4.0;

            return (
              <g className="pointer-events-none select-none">
                {/* Ghost Opening on Wall Baseline */}
                <line
                  x1={hx - (ux * openW) / 2}
                  y1={hy - (uy * openW) / 2}
                  x2={hx + (ux * openW) / 2}
                  y2={hy + (uy * openW) / 2}
                  stroke="#0284c7"
                  strokeWidth="4.0"
                  vectorEffect="non-scaling-stroke"
                />
                {/* Ghost Swing Arc if Door */}
                {activeTool === 'DR' && (
                  <circle
                    cx={hx - (ux * openW) / 2}
                    cy={hy - (uy * openW) / 2}
                    r={openW}
                    fill="none"
                    stroke="#0284c7"
                    strokeWidth="1.2"
                    strokeDasharray="4 3"
                    vectorEffect="non-scaling-stroke"
                    opacity="0.6"
                  />
                )}
                {/* Host Offset Dimension Text */}
                <text
                  x={hx}
                  y={-hy - 0.45}
                  transform="scale(1, -1)"
                  textAnchor="middle"
                  dominantBaseline="central"
                  fontSize="0.21"
                  fontFamily="JetBrains Mono, monospace"
                  fontWeight="bold"
                  fill="#0284c7"
                  paintOrder="stroke"
                  stroke="#ffffff"
                  strokeWidth="0.08"
                >
                  {`${activeTool === 'DR' ? 'Door' : 'Window'} @ ${formatLength(nw.proj, displayUnit)}`}
                </text>
              </g>
            );
          })()}

          {/* 8. Revit Selection Endpoint Grips & Flip Controls Overlay */}
          {selectedGuids.map((guid) => {
            const el = elements[guid];
            if (!el) return null;
            if (el.start && el.end) {
              const sx = el.start[0];
              const sy = el.start[1];
              const ex = el.end[0];
              const ey = el.end[1];
              const mx = (sx + ex) / 2;
              const my = (sy + ey) / 2;
              const dx = ex - sx;
              const dy = ey - sy;
              const len = Math.hypot(dx, dy);
              const nx = len > 0.001 ? -dy / len : 0;
              const ny = len > 0.001 ? dx / len : 0;
              const flipX = mx + nx * 0.6;
              const flipY = my + ny * 0.6;

              return (
                <g key={`grips-${guid}`} className="select-none pointer-events-auto">
                  {/* Start Point Grip */}
                  <circle
                    cx={sx}
                    cy={sy}
                    r={5 / scale}
                    fill="#ffffff"
                    stroke="#007acc"
                    strokeWidth={2 / scale}
                    className="hover:scale-125 transition-transform cursor-pointer"
                  />
                  {/* End Point Grip */}
                  <circle
                    cx={ex}
                    cy={ey}
                    r={5 / scale}
                    fill="#ffffff"
                    stroke="#007acc"
                    strokeWidth={2 / scale}
                    className="hover:scale-125 transition-transform cursor-pointer"
                  />
                  {/* Interactive Flip Arrows Control */}
                  <g
                    transform={`translate(${flipX}, ${flipY}) scale(${1 / scale}, ${-1 / scale})`}
                    className="cursor-pointer"
                    onClick={(e) => {
                      e.stopPropagation();
                      flipElementOrientation(guid);
                    }}
                  >
                    <title>Flip Wall Direction (Space)</title>
                    <circle cx="0" cy="0" r="10" fill="#0284c7" className="hover:fill-sky-700 shadow-sm" />
                    <text
                      x="0"
                      y="3.5"
                      textAnchor="middle"
                      fill="#ffffff"
                      fontSize="10"
                      fontWeight="bold"
                    >
                      ⇄
                    </text>
                  </g>
                </g>
              );
            }
            return null;
          })}
        </g>
      </svg>

      {/* Viewport Header Controls */}
      {(() => {
        const currentView = views.find((v) => v.id === activeViewId) || {
          name: 'Floor Plan: Level 1',
          viewRange: { cut: 4.0 },
        };
        return (
          <div className="absolute top-3 left-3 flex items-center space-x-2 bg-white/90 backdrop-blur px-3 py-1.5 rounded shadow border border-slate-300 text-xs text-slate-800 z-10 font-sans">
            <span className="font-bold">
              {/* UI-P0-2: the cut plane is decimal feet, so this rendered the value
                  in feet AND converted it as if it were metres — "(4'-0" / 4m)"
                  for a 4 ft cut. One number, one unit.
                  Track A6: An elevation is a projection with no cut plane, so suppress chip. */}
              {currentView.name}
              {(currentView as any).type !== 'elevation' && (
                <> (Cut Plane: {formatLength(currentView.viewRange?.cut ?? (currentView as any)?.view_range?.cut ?? 4.0, displayUnit)})</>
              )}
            </span>
            <span className="text-slate-400">|</span>
            <button
              onClick={resetView}
              className="p-1 hover:bg-slate-100 rounded text-slate-700"
              title="Zoom Extents (ZE)"
            >
              <Maximize2 size={13} />
            </button>
            <span className="text-slate-300">|</span>
            <button
              onClick={() => toggleSnaps()}
              className={`px-1.5 py-0.5 rounded text-[11px] font-medium flex items-center space-x-1 transition-colors ${
                snapsEnabled ? 'bg-sky-100 text-sky-800 hover:bg-sky-200' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
              }`}
              title="Toggle Object Snaps (F3)"
            >
              <Crosshair size={12} />
              <span>{snapsEnabled ? 'Snaps: ON' : 'Snaps: OFF'}</span>
            </button>
          </div>
        );
      })()}

      {/* In-Canvas Inline Dimension Editor (Revit-feel in-place editing) */}
      {editingDimension && (
        <div
          className="absolute z-30 -translate-x-1/2 -translate-y-1/2 flex items-center bg-white/95 px-2 py-1 rounded shadow-lg border border-sky-400 font-mono text-xs animate-fade-in"
          style={{
            left: `${pan.x + editingDimension.mx * scale}px`,
            top: `${pan.y - editingDimension.my * scale}px`,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <input
            type="text"
            autoFocus
            value={dimInputVal}
            placeholder={'12\'-6"'}
            onChange={(e) => setDimInputVal(e.target.value)}
            onKeyDown={async (e) => {
              if (e.key === 'Enter') {
                const feet = tryParseLength(dimInputVal);
                if (feet === null || feet <= 0) {
                  setStatusMessage(`Not a valid positive length: "${dimInputVal}". Try 12'-6", 12.5', or 3800 mm.`);
                  return;
                }
                try {
                  const targetLvl = levels.find((l) => l.id === editingDimension.id || l.name.toLowerCase() === editingDimension.id.toLowerCase());
                  if (targetLvl) {
                    await moveLevel(targetLvl.id, feet);
                  } else if (tempDimension && tempDimension.elementGuid === editingDimension.id) {
                    await applyTemporaryDimensionChange(feet);
                  } else {
                    await setDimensionValue(editingDimension.id, feet);
                  }
                } catch (err) {
                  console.error('Dimension edit failed', err);
                }
                setEditingDimension(null);
              } else if (e.key === 'Escape') {
                e.stopPropagation();
                setEditingDimension(null);
              }
            }}
            onBlur={() => setEditingDimension(null)}
            className="w-24 px-1.5 py-0.5 bg-slate-900 text-sky-100 rounded border border-sky-500 text-xs font-mono outline-none shadow-inner"
          />
        </div>
      )}

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

      {/* Trim / Extend to Corner Tool Active Banner */}
      {!sketchSession && activeTool === 'TR' && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-[#094771]/95 text-white px-4 py-2 rounded-lg border border-[#38bdf8] text-xs shadow-xl flex items-center space-x-3 z-30 animate-fade-in">
          <span className="w-2.5 h-2.5 rounded-full bg-sky-400 animate-ping" />
          <span className="font-medium">
            {!trimPickState.firstGuid
              ? 'TRIM / EXTEND (TR): Click 1st wall to keep (or grid / level datum)'
              : '1st wall selected. Click 2nd wall to form corner, or datum to extend.'}
          </span>
          <button
            onClick={() => {
              setActiveTool('select');
              setTrimPickState({ step: null, firstGuid: null, firstPoint: null });
            }}
            className="px-2 py-0.5 bg-black/40 hover:bg-black/60 rounded text-[10px] text-slate-200"
          >
            Cancel (Esc)
          </button>
        </div>
      )}

      {/* Split Wall Tool Active Banner */}
      {!sketchSession && activeTool === 'SL' && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-[#094771]/95 text-white px-4 py-2 rounded-lg border border-[#38bdf8] text-xs shadow-xl flex items-center space-x-3 z-30 animate-fade-in">
          <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse" />
          <span className="font-medium">
            SPLIT ELEMENT (SL): Click any wall along its length to split into two joined segments.
          </span>
          <button
            onClick={() => setActiveTool('select')}
            className="px-2 py-0.5 bg-black/40 hover:bg-black/60 rounded text-[10px] text-slate-200"
          >
            Cancel (Esc)
          </button>
        </div>
      )}

      {/* Split with Gap Tool Active Banner */}
      {!sketchSession && activeTool === 'SO' && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-[#094771]/95 text-white px-4 py-2 rounded-lg border border-[#38bdf8] text-xs shadow-xl flex items-center space-x-3 z-30 animate-fade-in">
          <span className="w-2.5 h-2.5 rounded-full bg-amber-400 animate-pulse" />
          <span className="font-medium">
            SPLIT WITH GAP (SO): Click wall to create 1'-0" expansion joint / gap.
          </span>
          <button
            onClick={() => setActiveTool('select')}
            className="px-2 py-0.5 bg-black/40 hover:bg-black/60 rounded text-[10px] text-slate-200"
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
      {!sketchSession &&
        activeTool !== 'select' &&
        activeTool !== 'AL' &&
        activeTool !== 'TR' &&
        activeTool !== 'SL' &&
        activeTool !== 'SO' && (
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-[#094771]/95 text-white px-4 py-2 rounded-lg border border-[#38bdf8] text-xs shadow-xl flex items-center space-x-3 z-30 animate-fade-in">
            <span className="w-2.5 h-2.5 rounded-full bg-sky-400 animate-ping" />
            <span className="font-medium">
              {activeTool === 'WA' && (!firstPoint ? 'WALL TOOL (WA): Click 1st point for wall baseline' : `Click 2nd point to place wall (${Math.hypot((currentPoint?.[0] || 0) - firstPoint[0], (currentPoint?.[1] || 0) - firstPoint[1]).toFixed(2)}')`)}
              {activeTool === 'RF' && (!firstPoint ? 'ROOF TOOL (RF): Click 1st corner for roof footprint' : `Click opposite corner to place pitched roof (${Math.abs((currentPoint?.[0] || 0) - firstPoint[0]).toFixed(1)}' × ${Math.abs((currentPoint?.[1] || 0) - firstPoint[1]).toFixed(1)}')`)}
              {activeTool === 'SB' && (!firstPoint ? 'FLOOR SLAB TOOL (SB): Click 1st corner for floor slab' : `Click opposite corner to place floor slab (${Math.abs((currentPoint?.[0] || 0) - firstPoint[0]).toFixed(1)}' × ${Math.abs((currentPoint?.[1] || 0) - firstPoint[1]).toFixed(1)}')`)}
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
