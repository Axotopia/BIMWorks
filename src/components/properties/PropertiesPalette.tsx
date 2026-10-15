import React, { useState, useEffect } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Check,
  X,
  AlertCircle,
  Sparkles,
  Move,
  Trash2,
  SlidersHorizontal,
  Layers,
  Box,
} from 'lucide-react';
import { useBimStore } from '../../store/useBimStore';
import { formatLength, formatArea, formatVolume } from '../../utils/units';
import { measureMesh } from '../../utils/geometry';
import {
  IconHouse3D,
  IconWall,
  IconDoor,
  IconWindow,
  IconRoof,
  IconFloor,
  IconEditType,
} from '../icons/RevitIcons';

/** Nudge step in the engine's internal unit (decimal feet): 6 inches. */
const NUDGE_FT = 0.5;

export const PropertiesPalette: React.FC = () => {
  const {
    selectedGuid,
    meshes,
    deleteElement,
    updateElement,
    translateElement,
    setEditTypeModalOpen,
    setViewRangeModalOpen,
    displayUnit,
    views,
    activeViewId,
    activeScale,
    activeDetailLevel,
    setDetailLevel,
    sectionBox,
    toggleSectionBox,
    sketchSession,
    finishSketchMode,
    cancelSketchMode,
    updateSketchLine,
    deleteSelectedSketchLine,
    setSketchParam,
  } = useBimStore();

  const selectedMesh = meshes.find((m) => m.guid === selectedGuid);
  const activeView = views.find((v) => v.id === activeViewId);
  const isElementSelected = Boolean(selectedMesh);

  const params = selectedMesh?.params;
  const measure = selectedMesh ? measureMesh(selectedMesh) : null;

  const isRoof =
    selectedMesh?.ifc_class === 'IfcRoof' ||
    (selectedMesh?.name || '').toLowerCase().includes('roof');
  const isWall =
    selectedMesh?.ifc_class === 'IfcWall' ||
    selectedMesh?.ifc_class === 'IfcWallStandardCase';
  const isSlab = selectedMesh?.ifc_class === 'IfcSlab' && !isRoof;
  const isDoor = selectedMesh?.ifc_class === 'IfcDoor';
  const isWindow = selectedMesh?.ifc_class === 'IfcWindow';

  // Live element metadata fetched from backend
  const [elementData, setElementData] = useState<any>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [saveSuccess, setSaveSuccess] = useState<boolean>(false);

  // Editable form state
  const [formPitch, setFormPitch] = useState<string>('15.0');
  const [formElevation, setFormElevation] = useState<string>('6.0');
  const [formThickness, setFormThickness] = useState<string>('0.3');
  const [formHeight, setFormHeight] = useState<string>('3.0');
  const [formWidth, setFormWidth] = useState<string>('0.9');
  const [formOffset, setFormOffset] = useState<string>('0.0');
  const [formStartX, setFormStartX] = useState<string>('0.0');
  const [formStartY, setFormStartY] = useState<string>('0.0');
  const [formEndX, setFormEndX] = useState<string>('10.0');
  const [formEndY, setFormEndY] = useState<string>('0.0');
  const [formPolygon, setFormPolygon] = useState<[number, number][]>([]);

  // Section collapse states matching Revit groups
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({
    graphics: false,
    extents: false,
    camera: false,
    identity: false,
    phasing: false,
    viewPosition: false,
    constraints: false,
    dimensions: false,
  });

  const toggleGroup = (grp: string) => {
    setCollapsedGroups((prev) => ({ ...prev, [grp]: !prev[grp] }));
  };

  // Fetch detailed element metadata whenever selectedGuid changes
  useEffect(() => {
    if (!selectedGuid) {
      setElementData(null);
      return;
    }

    let isMounted = true;
    setIsLoading(true);

    fetch(`http://127.0.0.1:8008/api/element/${selectedGuid}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!isMounted) return;
        setIsLoading(false);
        if (data) {
          setElementData(data);
          setFormPitch(data.pitch ? data.pitch.toFixed(1) : '15.0');
          setFormElevation(data.elevation !== undefined ? data.elevation.toFixed(2) : '0.00');
          setFormThickness(data.thickness !== undefined ? data.thickness.toFixed(2) : '0.25');
          setFormHeight(data.height !== undefined ? data.height.toFixed(2) : '3.00');
          setFormWidth(data.width !== undefined ? data.width.toFixed(2) : '0.90');
          setFormOffset(data.offset_along_wall !== undefined ? data.offset_along_wall.toFixed(2) : '0.00');
          if (data.start) {
            setFormStartX(data.start[0].toFixed(2));
            setFormStartY(data.start[1].toFixed(2));
          }
          if (data.end) {
            setFormEndX(data.end[0].toFixed(2));
            setFormEndY(data.end[1].toFixed(2));
          }
          if (data.polygon) {
            setFormPolygon(data.polygon);
          }
        }
      })
      .catch((e) => {
        console.error('Failed to fetch element details', e);
        if (isMounted) setIsLoading(false);
      });

    return () => {
      isMounted = false;
    };
  }, [selectedGuid]);

  const handleApplyChanges = async () => {
    if (!selectedGuid) return;
    const updates: any = {};

    if (isRoof) {
      updates.pitch = parseFloat(formPitch) || 15.0;
      updates.elevation = parseFloat(formElevation) || 0.0;
      updates.thickness = parseFloat(formThickness) || 0.3;
      if (formPolygon.length >= 3) {
        updates.polygon = formPolygon;
      }
    } else if (isWall) {
      updates.height = parseFloat(formHeight) || 3.0;
      updates.thickness = parseFloat(formThickness) || 0.2;
      updates.start = [parseFloat(formStartX) || 0, parseFloat(formStartY) || 0, 0];
      updates.end = [parseFloat(formEndX) || 0, parseFloat(formEndY) || 0, 0];
    } else if (isSlab) {
      updates.elevation = parseFloat(formElevation) || 0.0;
      updates.thickness = parseFloat(formThickness) || 0.25;
      if (formPolygon.length >= 3) {
        updates.polygon = formPolygon;
      }
    } else if (isDoor || isWindow) {
      updates.offset_along_wall = parseFloat(formOffset) || 0.0;
      updates.width = parseFloat(formWidth) || 0.9;
    }

    await updateElement(selectedGuid, updates);
    setSaveSuccess(true);
    setTimeout(() => setSaveSuccess(false), 2000);
  };

  const handleNudge = async (dx: number, dy: number, dz: number) => {
    if (!selectedGuid) return;
    await translateElement(selectedGuid, dx, dy, dz);
  };

  // Thumbnail icon for Type Selector
  const renderThumbnail = () => {
    if (isElementSelected) {
      if (isWall) return <IconWall size={28} />;
      if (isDoor) return <IconDoor size={28} />;
      if (isWindow) return <IconWindow size={28} />;
      if (isRoof) return <IconRoof size={28} />;
      if (isSlab) return <IconFloor size={28} />;
      return <Box size={28} className="text-[#0284c7]" />;
    }
    if (activeView?.type === '3d') return <IconHouse3D size={28} />;
    return <Layers size={28} className="text-[#0284c7]" />;
  };

  // Category Header component matching Revit Image 2
  const CategoryHeader: React.FC<{
    title: string;
    id: string;
  }> = ({ title, id }) => (
    <div
      onClick={() => toggleGroup(id)}
      className="flex items-center justify-between px-2 py-1 bg-[#e8e8e8] hover:bg-[#dfdfdf] border-y border-[#d4d4d4] cursor-pointer select-none"
    >
      <span className="font-bold text-[11px] text-[#202020]">{title}</span>
      {collapsedGroups[id] ? (
        <ChevronRight size={13} className="text-[#555555]" />
      ) : (
        <ChevronDown size={13} className="text-[#555555]" />
      )}
    </div>
  );

  return (
    <div className="h-full w-full bg-[#ffffff] text-[#222222] flex flex-col border-l border-[#dcdcdc] select-none text-[11px] font-sans overflow-hidden">
      {/* 1. Window Header */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-[#f0f0f0] border-b border-[#dcdcdc]">
        <span className="font-semibold text-xs text-[#202020]">Properties</span>
      </div>

      {/* 2. Type Selector Card (Image 2 Parity) */}
      <div className="p-2 bg-[#f9f9f9] border-b border-[#dcdcdc]">
        <div className="flex items-center space-x-2 bg-[#ffffff] border border-[#d0d0d0] rounded p-1.5 shadow-sm">
          {/* Thumbnail preview */}
          <div className="w-12 h-12 bg-[#f8fafc] border border-[#e2e8f0] rounded flex items-center justify-center shrink-0">
            {renderThumbnail()}
          </div>

          {/* Type / Family Name & Dropdown */}
          <div className="flex-1 min-w-0 pr-1">
            <div className="font-bold text-[11px] text-[#202020] truncate">
              {isElementSelected
                ? selectedMesh?.name || 'Selected Element'
                : activeView?.type === '3d'
                ? '3D View'
                : 'Floor Plan'}
            </div>
            <div className="flex items-center justify-between mt-1 px-1.5 py-0.5 bg-[#ffffff] border border-[#cccccc] hover:border-[#007acc] rounded cursor-pointer text-[11px] text-[#333333]">
              <span className="truncate">
                {isElementSelected
                  ? `${selectedMesh?.ifc_class}: ${selectedMesh?.name}`
                  : `${activeView?.name || '3D View: Cover Sheet View'}`}
              </span>
              <ChevronDown size={12} className="text-[#666666] ml-1 shrink-0" />
            </div>
          </div>

          {/* Edit Type Button */}
          <button
            onClick={() => setEditTypeModalOpen(true)}
            className="flex items-center space-x-1 px-2 py-1 bg-[#f3f4f6] hover:bg-[#e5e7eb] text-[#1e293b] rounded border border-[#d1d5db] font-medium text-[10px] shrink-0 shadow-xs"
            title="Edit Type Properties"
          >
            <IconEditType size={12} />
            <span>Edit Type</span>
          </button>
        </div>
      </div>

      {/* 3. Properties Parameter Grid */}
      <div className="flex-1 overflow-y-auto bg-[#ffffff]">
        {/* SKETCH MODE OVERRIDE */}
        {sketchSession ? (
          <div className="p-2 space-y-2">
            <div className="bg-[#f0fdf4] border border-[#22c55e] p-2.5 rounded shadow-xs">
              <div className="flex items-center space-x-1.5 text-[#15803d] font-bold text-xs uppercase mb-1">
                <Sparkles size={14} />
                <span>
                  {sketchSession.mode === 'roof' ? 'Roof Footprint Sketch' : 'Floor Boundary Sketch'}
                </span>
              </div>
              <p className="text-[11px] text-[#166534] mb-2 leading-tight">
                {sketchSession.isEditingExisting
                  ? `Editing geometry of ${sketchSession.targetName || 'element'}. Draw/modify magenta boundary lines.`
                  : 'Draw closed magenta boundary loop using Line, Rectangle, or Pick Walls.'}
              </p>

              <div className="flex items-center space-x-2">
                <button
                  onClick={() => finishSketchMode()}
                  className="flex-1 flex items-center justify-center space-x-1 py-1 bg-[#16a34a] hover:bg-[#15803d] text-white rounded text-xs font-semibold shadow"
                >
                  <Check size={14} />
                  <span>Finish (Enter)</span>
                </button>
                <button
                  onClick={() => cancelSketchMode()}
                  className="flex-1 flex items-center justify-center space-x-1 py-1 bg-[#dc2626] hover:bg-[#b91c1c] text-white rounded text-xs font-semibold shadow"
                >
                  <X size={14} />
                  <span>Cancel (Esc)</span>
                </button>
              </div>

              {sketchSession.validationError && (
                <div className="mt-2 p-1.5 bg-[#fef2f2] border border-[#ef4444] rounded text-red-700 text-xs flex items-start space-x-1">
                  <AlertCircle size={13} className="text-[#ef4444] shrink-0 mt-0.5" />
                  <span>{sketchSession.validationError}</span>
                </div>
              )}
            </div>

            {/* Sketch Parameters */}
            <div className="border border-[#dcdcdc] rounded overflow-hidden">
              <CategoryHeader title="Sketch Parameters" id="sketch" />
              <table className="w-full text-[11px]">
                <tbody>
                  <tr className="border-b border-[#f0f0f0]">
                    <td className="py-1 px-2 text-[#475569] w-1/2">Base Elevation</td>
                    <td className="py-1 px-2 text-right">
                      <input
                        type="number"
                        step="0.1"
                        value={sketchSession.elevation}
                        onChange={(e) => setSketchParam('elevation', parseFloat(e.target.value) || 0)}
                        className="w-20 px-1 py-0.5 border border-[#cccccc] rounded text-right font-mono"
                      />
                    </td>
                  </tr>
                  <tr className="border-b border-[#f0f0f0]">
                    <td className="py-1 px-2 text-[#475569]">Thickness</td>
                    <td className="py-1 px-2 text-right">
                      <input
                        type="number"
                        step="0.05"
                        value={sketchSession.thickness}
                        onChange={(e) => setSketchParam('thickness', parseFloat(e.target.value) || 0.25)}
                        className="w-20 px-1 py-0.5 border border-[#cccccc] rounded text-right font-mono"
                      />
                    </td>
                  </tr>
                  {sketchSession.mode === 'roof' && (
                    <tr className="border-b border-[#f0f0f0]">
                      <td className="py-1 px-2 text-[#475569]">Slope Pitch (deg)</td>
                      <td className="py-1 px-2 text-right">
                        <input
                          type="number"
                          step="0.5"
                          value={sketchSession.pitch}
                          onChange={(e) => {
                            const val = parseFloat(e.target.value) || 0;
                            setSketchParam('pitch', val);
                            setSketchParam('defaultSlopeAngle', val);
                          }}
                          className="w-20 px-1 py-0.5 border border-[#cccccc] rounded text-right font-mono"
                        />
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {/* Selected Sketch Line */}
            {sketchSession.selectedLineId && (() => {
              const selLine = sketchSession.lines.find((l) => l.id === sketchSession.selectedLineId);
              if (!selLine) return null;
              const len = Math.hypot(selLine.end[0] - selLine.start[0], selLine.end[1] - selLine.start[1]);
              return (
                <div className="bg-[#f0f9ff] border border-[#bae6fd] p-2 rounded space-y-1.5 text-xs">
                  <div className="flex items-center justify-between text-[#0284c7] font-bold text-[10px] uppercase">
                    <span>Selected Boundary Line</span>
                    <button
                      onClick={() => deleteSelectedSketchLine()}
                      className="text-red-500 hover:text-red-700 p-0.5"
                      title="Delete Line"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                  <div className="text-[11px] text-[#334155]">
                    Length: <span className="font-mono font-semibold">{len.toFixed(2)}'</span>
                  </div>
                  {sketchSession.mode === 'roof' && (
                    <label className="flex items-center space-x-1.5 cursor-pointer mt-1">
                      <input
                        type="checkbox"
                        checked={Boolean(selLine.definesSlope)}
                        onChange={(e) => updateSketchLine(selLine.id, { definesSlope: e.target.checked })}
                        className="rounded border-[#cbd5e1] text-[#0284c7]"
                      />
                      <span className="text-[#1e293b] text-xs">Defines Roof Slope</span>
                    </label>
                  )}
                </div>
              );
            })()}
          </div>
        ) : isElementSelected ? (
          /* ELEMENT IS SELECTED (Wall, Door, Window, Roof, Floor) */
          <div>
            {/* Constraints Group */}
            <CategoryHeader title="Constraints" id="constraints" />
            {!collapsedGroups.constraints && (
              <table className="w-full text-[11px]">
                <tbody>
                  <tr className="border-b border-[#f0f0f0]">
                    <td className="py-1 px-2 text-[#475569]">Base Level</td>
                    <td className="py-1 px-2 text-right font-mono text-[#1e293b]">
                      {params?.level_id ?? 'Level 1'}
                    </td>
                  </tr>
                  <tr className="border-b border-[#f0f0f0]">
                    <td className="py-1 px-2 text-[#475569]">Base Offset</td>
                    <td className="py-1 px-2 text-right font-mono text-[#1e293b]">0' 0"</td>
                  </tr>
                  <tr className="border-b border-[#f0f0f0]">
                    <td className="py-1 px-2 text-[#475569]">Top Constraint</td>
                    <td className="py-1 px-2 text-right font-mono text-[#1e293b]">Up to Level 2</td>
                  </tr>
                  <tr className="border-b border-[#f0f0f0]">
                    <td className="py-1 px-2 text-[#475569]">Unconnected Height</td>
                    <td className="py-1 px-2 text-right font-mono text-[#1e293b]">
                      {typeof params?.height === 'number'
                        ? formatLength(params.height, displayUnit)
                        : '10\' 0"'}
                    </td>
                  </tr>
                </tbody>
              </table>
            )}

            {/* Dimensions Group */}
            <CategoryHeader title="Dimensions" id="dimensions" />
            {!collapsedGroups.dimensions && (
              <table className="w-full text-[11px]">
                <tbody>
                  <tr className="border-b border-[#f0f0f0]">
                    <td className="py-1 px-2 text-[#475569]">Length</td>
                    <td className="py-1 px-2 text-right font-mono text-[#0284c7]">
                      {params?.length != null
                        ? formatLength(params.length, displayUnit)
                        : selectedMesh?.bbox
                        ? (() => {
                            const lenFt = Math.hypot(
                              selectedMesh.bbox.max[0] - selectedMesh.bbox.min[0],
                              selectedMesh.bbox.max[1] - selectedMesh.bbox.min[1]
                            );
                            return formatLength(lenFt, displayUnit);
                          })()
                        : '—'}
                    </td>
                  </tr>
                  <tr className="border-b border-[#f0f0f0]">
                    <td className="py-1 px-2 text-[#475569]">Area</td>
                    <td className="py-1 px-2 text-right font-mono text-[#0284c7]">
                      {measure ? formatArea(measure.areaFt2, displayUnit) : '—'}
                    </td>
                  </tr>
                  <tr className="border-b border-[#f0f0f0]">
                    <td className="py-1 px-2 text-[#475569]">Volume</td>
                    <td className="py-1 px-2 text-right font-mono text-[#0284c7]">
                      {measure ? formatVolume(measure.volumeFt3, displayUnit) : '—'}
                    </td>
                  </tr>
                </tbody>
              </table>
            )}

            {/* Editable Geometry Parameters */}
            <CategoryHeader title="Geometry &amp; Parameters" id="geometry" />
            <div className="p-2 space-y-2 bg-[#fcfcfc] border-b border-[#dcdcdc]">
              {isRoof && (
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <span className="text-[#475569]">Roof Pitch (deg)</span>
                    <input
                      type="number"
                      step="0.5"
                      value={formPitch}
                      onChange={(e) => setFormPitch(e.target.value)}
                      className="w-20 px-1.5 py-0.5 border border-[#cccccc] rounded text-right font-mono text-xs"
                    />
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-[#475569]">Plate Elevation (ft)</span>
                    <input
                      type="number"
                      step="0.25"
                      value={formElevation}
                      onChange={(e) => setFormElevation(e.target.value)}
                      className="w-20 px-1.5 py-0.5 border border-[#cccccc] rounded text-right font-mono text-xs"
                    />
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-[#475569]">Thickness (ft)</span>
                    <input
                      type="number"
                      step="0.05"
                      value={formThickness}
                      onChange={(e) => setFormThickness(e.target.value)}
                      className="w-20 px-1.5 py-0.5 border border-[#cccccc] rounded text-right font-mono text-xs"
                    />
                  </div>
                </div>
              )}

              {isWall && (
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <span className="text-[#475569]">Wall Height (m)</span>
                    <input
                      type="number"
                      step="0.25"
                      value={formHeight}
                      onChange={(e) => setFormHeight(e.target.value)}
                      className="w-20 px-1.5 py-0.5 border border-[#cccccc] rounded text-right font-mono text-xs"
                    />
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-[#475569]">Thickness (m)</span>
                    <input
                      type="number"
                      step="0.05"
                      value={formThickness}
                      onChange={(e) => setFormThickness(e.target.value)}
                      className="w-20 px-1.5 py-0.5 border border-[#cccccc] rounded text-right font-mono text-xs"
                    />
                  </div>
                </div>
              )}

              {(isDoor || isWindow) && (
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <span className="text-[#475569]">Offset Along Wall (m)</span>
                    <input
                      type="number"
                      step="0.1"
                      value={formOffset}
                      onChange={(e) => setFormOffset(e.target.value)}
                      className="w-20 px-1.5 py-0.5 border border-[#cccccc] rounded text-right font-mono text-xs"
                    />
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-[#475569]">Width (m)</span>
                    <input
                      type="number"
                      step="0.05"
                      value={formWidth}
                      onChange={(e) => setFormWidth(e.target.value)}
                      className="w-20 px-1.5 py-0.5 border border-[#cccccc] rounded text-right font-mono text-xs"
                    />
                  </div>
                  {isDoor && (
                    <button
                      onClick={() => {
                        const flipped = !elementData?.swing_flipped;
                        updateElement(selectedGuid!, { swing_flipped: flipped });
                      }}
                      className="w-full py-1 bg-[#f1f5f9] hover:bg-[#e2e8f0] text-[#1e293b] rounded border border-[#cbd5e1] text-[10px] font-medium"
                    >
                      Flip Swing Orientation
                    </button>
                  )}
                </div>
              )}

              <button
                onClick={handleApplyChanges}
                className="w-full py-1.5 bg-[#0284c7] hover:bg-[#0369a1] text-white rounded font-medium text-xs shadow flex items-center justify-center space-x-1"
              >
                <Check size={13} />
                <span>{saveSuccess ? 'Changes Applied!' : 'Apply Geometry Changes'}</span>
              </button>
            </div>

            {/* Spatial Translation / Nudge Controls */}
            <div className="p-2 border-b border-[#dcdcdc] bg-[#f9fafb]">
              <div className="text-[10px] font-bold text-[#64748b] mb-1 flex items-center space-x-1 uppercase">
                <Move size={12} />
                <span>Spatial Translation / Move</span>
              </div>
              <div className="grid grid-cols-3 gap-1 text-[10px] font-mono">
                <button
                  onClick={() => handleNudge(-NUDGE_FT, 0, 0)}
                  className="py-1 bg-[#ffffff] hover:bg-[#f1f5f9] text-[#1e293b] rounded border border-[#d1d5db]"
                >
                  -X (6")
                </button>
                <button
                  onClick={() => handleNudge(0, NUDGE_FT, 0)}
                  className="py-1 bg-[#ffffff] hover:bg-[#f1f5f9] text-[#1e293b] rounded border border-[#d1d5db]"
                >
                  +Y (6")
                </button>
                <button
                  onClick={() => handleNudge(NUDGE_FT, 0, 0)}
                  className="py-1 bg-[#ffffff] hover:bg-[#f1f5f9] text-[#1e293b] rounded border border-[#d1d5db]"
                >
                  +X (6")
                </button>
                <button
                  onClick={() => handleNudge(0, 0, -NUDGE_FT)}
                  className="py-1 bg-[#ffffff] hover:bg-[#f1f5f9] text-[#1e293b] rounded border border-[#d1d5db]"
                >
                  -Z (Down)
                </button>
                <button
                  onClick={() => handleNudge(0, -NUDGE_FT, 0)}
                  className="py-1 bg-[#ffffff] hover:bg-[#f1f5f9] text-[#1e293b] rounded border border-[#d1d5db]"
                >
                  -Y (6")
                </button>
                <button
                  onClick={() => handleNudge(0, 0, NUDGE_FT)}
                  className="py-1 bg-[#ffffff] hover:bg-[#f1f5f9] text-[#1e293b] rounded border border-[#d1d5db]"
                >
                  +Z (Up)
                </button>
              </div>
            </div>

            {/* Identity Data Group */}
            <CategoryHeader title="Identity Data" id="identity" />
            {!collapsedGroups.identity && (
              <table className="w-full text-[11px]">
                <tbody>
                  <tr className="border-b border-[#f0f0f0]">
                    <td className="py-1 px-2 text-[#475569]">IFC Class</td>
                    <td className="py-1 px-2 text-right font-mono text-[#1e293b]">
                      {selectedMesh?.ifc_class}
                    </td>
                  </tr>
                  <tr className="border-b border-[#f0f0f0]">
                    <td className="py-1 px-2 text-[#475569]">IFC GUID</td>
                    <td className="py-1 px-2 text-right font-mono text-[9px] text-[#64748b] truncate max-w-[120px]">
                      {selectedMesh?.guid}
                    </td>
                  </tr>
                  <tr className="border-b border-[#f0f0f0]">
                    <td className="py-1 px-2 text-[#475569]">Comments</td>
                    <td className="py-1 px-2 text-right font-mono text-[#94a3b8]">&lt;None&gt;</td>
                  </tr>
                  <tr className="border-b border-[#f0f0f0]">
                    <td className="py-1 px-2 text-[#475569]">Mark</td>
                    <td className="py-1 px-2 text-right font-mono text-[#1e293b]">1</td>
                  </tr>
                </tbody>
              </table>
            )}

            {/* Phasing Group */}
            <CategoryHeader title="Phasing" id="phasing" />
            {!collapsedGroups.phasing && (
              <table className="w-full text-[11px]">
                <tbody>
                  <tr className="border-b border-[#f0f0f0]">
                    <td className="py-1 px-2 text-[#475569]">Phase Created</td>
                    <td className="py-1 px-2 text-right font-mono text-[#1e293b]">New Construction</td>
                  </tr>
                  <tr className="border-b border-[#f0f0f0]">
                    <td className="py-1 px-2 text-[#475569]">Phase Demolished</td>
                    <td className="py-1 px-2 text-right font-mono text-[#94a3b8]">None</td>
                  </tr>
                </tbody>
              </table>
            )}

            {/* Delete Element Button */}
            <div className="p-2 pt-3">
              <button
                onClick={() => selectedGuid && deleteElement(selectedGuid)}
                className="w-full flex items-center justify-center space-x-1.5 py-1.5 bg-[#fef2f2] hover:bg-[#fee2e2] text-[#dc2626] rounded border border-[#fca5a5] text-xs font-semibold shadow-xs"
              >
                <Trash2 size={13} />
                <span>Delete Element</span>
              </button>
            </div>
          </div>
        ) : (
          /* ACTIVE VIEW PROPERTIES (Exact Image 2 Parity) */
          <div>
            {/* Graphics Group */}
            <CategoryHeader title="Graphics" id="graphics" />
            {!collapsedGroups.graphics && (
              <table className="w-full text-[11px]">
                <tbody>
                  <tr className="border-b border-[#f0f0f0]">
                    <td className="py-1 px-2 text-[#333333]">Detail Level</td>
                    <td className="py-1 px-2 text-right">
                      <select
                        value={activeDetailLevel}
                        onChange={(e) => setDetailLevel(e.target.value as any)}
                        className="bg-transparent border border-[#cccccc] rounded px-1.5 py-0.5 text-[11px] text-[#111827] cursor-pointer"
                      >
                        <option value="fine">Fine</option>
                        <option value="medium">Medium</option>
                        <option value="coarse">Coarse</option>
                      </select>
                    </td>
                  </tr>
                  <tr className="border-b border-[#f0f0f0]">
                    <td className="py-1 px-2 text-[#333333]">Parts Visibility</td>
                    <td className="py-1 px-2 text-right text-[#111827]">Show Original</td>
                  </tr>
                  <tr className="border-b border-[#f0f0f0]">
                    <td className="py-1 px-2 text-[#333333]">Detail Number</td>
                    <td className="py-1 px-2 text-right font-mono text-[#111827]">1</td>
                  </tr>
                  <tr className="border-b border-[#f0f0f0]">
                    <td className="py-1 px-2 text-[#333333]">Rotation on Sheet</td>
                    <td className="py-1 px-2 text-right text-[#111827]">None</td>
                  </tr>
                  <tr className="border-b border-[#f0f0f0]">
                    <td className="py-1 px-2 text-[#333333]">Visibility/Graphics Overrides</td>
                    <td className="py-1 px-2 text-right">
                      <button
                        onClick={() => setViewRangeModalOpen(true)}
                        className="px-2 py-0.5 bg-[#f3f4f6] hover:bg-[#e5e7eb] border border-[#d1d5db] rounded text-[10px] text-[#1e293b]"
                      >
                        Edit...
                      </button>
                    </td>
                  </tr>
                  <tr className="border-b border-[#f0f0f0]">
                    <td className="py-1 px-2 text-[#333333]">Graphic Display Options</td>
                    <td className="py-1 px-2 text-right">
                      <button className="px-2 py-0.5 bg-[#f3f4f6] hover:bg-[#e5e7eb] border border-[#d1d5db] rounded text-[10px] text-[#1e293b]">
                        Edit...
                      </button>
                    </td>
                  </tr>
                  <tr className="border-b border-[#f0f0f0]">
                    <td className="py-1 px-2 text-[#333333]">Discipline</td>
                    <td className="py-1 px-2 text-right text-[#111827]">Coordination</td>
                  </tr>
                  <tr className="border-b border-[#f0f0f0]">
                    <td className="py-1 px-2 text-[#333333]">Default Analysis Display Style</td>
                    <td className="py-1 px-2 text-right text-[#64748b]">None</td>
                  </tr>
                  <tr className="border-b border-[#f0f0f0]">
                    <td className="py-1 px-2 text-[#333333]">Show Grids</td>
                    <td className="py-1 px-2 text-right">
                      <button className="px-2 py-0.5 bg-[#f3f4f6] hover:bg-[#e5e7eb] border border-[#d1d5db] rounded text-[10px] text-[#1e293b]">
                        Edit...
                      </button>
                    </td>
                  </tr>
                  <tr className="border-b border-[#f0f0f0]">
                    <td className="py-1 px-2 text-[#333333]">Sun Path</td>
                    <td className="py-1 px-2 text-right">
                      <input type="checkbox" className="rounded border-[#cbd5e1] text-[#0284c7]" />
                    </td>
                  </tr>
                </tbody>
              </table>
            )}

            {/* Extents Group */}
            <CategoryHeader title="Extents" id="extents" />
            {!collapsedGroups.extents && (
              <table className="w-full text-[11px]">
                <tbody>
                  <tr className="border-b border-[#f0f0f0]">
                    <td className="py-1 px-2 text-[#333333]">Crop View</td>
                    <td className="py-1 px-2 text-right">
                      <input
                        type="checkbox"
                        defaultChecked
                        className="rounded border-[#cbd5e1] text-[#0284c7]"
                      />
                    </td>
                  </tr>
                  <tr className="border-b border-[#f0f0f0]">
                    <td className="py-1 px-2 text-[#333333]">Crop Region Visible</td>
                    <td className="py-1 px-2 text-right">
                      <input type="checkbox" className="rounded border-[#cbd5e1] text-[#0284c7]" />
                    </td>
                  </tr>
                  <tr className="border-b border-[#f0f0f0]">
                    <td className="py-1 px-2 text-[#333333]">Far Clip Active</td>
                    <td className="py-1 px-2 text-right">
                      <input type="checkbox" className="rounded border-[#cbd5e1] text-[#0284c7]" />
                    </td>
                  </tr>
                  <tr className="border-b border-[#f0f0f0]">
                    <td className="py-1 px-2 text-[#333333]">Far Clip Offset</td>
                    <td className="py-1 px-2 text-right font-mono text-[#111827]">1000' 0"</td>
                  </tr>
                  <tr className="border-b border-[#f0f0f0]">
                    <td className="py-1 px-2 text-[#333333]">Scope Box</td>
                    <td className="py-1 px-2 text-right text-[#64748b]">None</td>
                  </tr>
                  <tr className="border-b border-[#f0f0f0]">
                    <td className="py-1 px-2 text-[#333333]">Section Box</td>
                    <td className="py-1 px-2 text-right">
                      <input
                        type="checkbox"
                        checked={sectionBox.enabled}
                        onChange={() => toggleSectionBox()}
                        className="rounded border-[#cbd5e1] text-[#0284c7] cursor-pointer"
                        title="Toggle Section Box"
                      />
                    </td>
                  </tr>
                </tbody>
              </table>
            )}

            {/* Camera Group */}
            <CategoryHeader title="Camera" id="camera" />
            {!collapsedGroups.camera && (
              <table className="w-full text-[11px]">
                <tbody>
                  <tr className="border-b border-[#f0f0f0]">
                    <td className="py-1 px-2 text-[#333333]">Rendering Settings</td>
                    <td className="py-1 px-2 text-right">
                      <button className="px-2 py-0.5 bg-[#f3f4f6] hover:bg-[#e5e7eb] border border-[#d1d5db] rounded text-[10px] text-[#1e293b]">
                        Edit...
                      </button>
                    </td>
                  </tr>
                  <tr className="border-b border-[#f0f0f0]">
                    <td className="py-1 px-2 text-[#333333]">Locked Orientation</td>
                    <td className="py-1 px-2 text-right">
                      <input type="checkbox" className="rounded border-[#cbd5e1] text-[#0284c7]" />
                    </td>
                  </tr>
                  <tr className="border-b border-[#f0f0f0]">
                    <td className="py-1 px-2 text-[#333333]">Projection Mode</td>
                    <td className="py-1 px-2 text-right text-[#111827]">Perspective</td>
                  </tr>
                  <tr className="border-b border-[#f0f0f0]">
                    <td className="py-1 px-2 text-[#333333]">Eye Elevation</td>
                    <td className="py-1 px-2 text-right font-mono text-[#111827]">168' 9 13/64"</td>
                  </tr>
                  <tr className="border-b border-[#f0f0f0]">
                    <td className="py-1 px-2 text-[#333333]">Target Elevation</td>
                    <td className="py-1 px-2 text-right font-mono text-[#111827]">-5' 5 87/128"</td>
                  </tr>
                  <tr className="border-b border-[#f0f0f0]">
                    <td className="py-1 px-2 text-[#333333]">Camera Position</td>
                    <td className="py-1 px-2 text-right text-[#111827]">Explicit</td>
                  </tr>
                </tbody>
              </table>
            )}

            {/* Identity Data Group */}
            <CategoryHeader title="Identity Data" id="identity" />
            {!collapsedGroups.identity && (
              <table className="w-full text-[11px]">
                <tbody>
                  <tr className="border-b border-[#f0f0f0]">
                    <td className="py-1 px-2 text-[#333333]">View Template</td>
                    <td className="py-1 px-2 text-right font-mono text-[#64748b]">&lt;None&gt;</td>
                  </tr>
                  <tr className="border-b border-[#f0f0f0]">
                    <td className="py-1 px-2 text-[#333333]">View Name</td>
                    <td className="py-1 px-2 text-right font-mono text-[#111827]">
                      {activeView?.name || 'Cover Sheet View'}
                    </td>
                  </tr>
                  <tr className="border-b border-[#f0f0f0]">
                    <td className="py-1 px-2 text-[#333333]">Dependency</td>
                    <td className="py-1 px-2 text-right text-[#111827]">Independent</td>
                  </tr>
                  <tr className="border-b border-[#f0f0f0]">
                    <td className="py-1 px-2 text-[#333333]">Title on Sheet</td>
                    <td className="py-1 px-2 text-right font-mono text-[#111827]"></td>
                  </tr>
                  <tr className="border-b border-[#f0f0f0]">
                    <td className="py-1 px-2 text-[#333333]">Sheet Collection</td>
                    <td className="py-1 px-2 text-right font-mono text-[#64748b]">&lt;None&gt;</td>
                  </tr>
                  <tr className="border-b border-[#f0f0f0]">
                    <td className="py-1 px-2 text-[#333333]">Sheet Number</td>
                    <td className="py-1 px-2 text-right font-mono text-[#111827]">G100</td>
                  </tr>
                  <tr className="border-b border-[#f0f0f0]">
                    <td className="py-1 px-2 text-[#333333]">Sheet Name</td>
                    <td className="py-1 px-2 text-right font-mono text-[#111827]">Cover</td>
                  </tr>
                </tbody>
              </table>
            )}

            {/* Phasing Group */}
            <CategoryHeader title="Phasing" id="phasing" />
            {!collapsedGroups.phasing && (
              <table className="w-full text-[11px]">
                <tbody>
                  <tr className="border-b border-[#f0f0f0]">
                    <td className="py-1 px-2 text-[#333333]">Phase Filter</td>
                    <td className="py-1 px-2 text-right text-[#111827]">Show All</td>
                  </tr>
                  <tr className="border-b border-[#f0f0f0]">
                    <td className="py-1 px-2 text-[#333333]">Phase</td>
                    <td className="py-1 px-2 text-right text-[#111827]">New Construction</td>
                  </tr>
                </tbody>
              </table>
            )}

            {/* View to Sheet Positioning Group */}
            <CategoryHeader title="View to Sheet Positioning" id="viewPosition" />
            {!collapsedGroups.viewPosition && (
              <table className="w-full text-[11px]">
                <tbody>
                  <tr className="border-b border-[#f0f0f0]">
                    <td className="py-1 px-2 text-[#333333]">Saved Position</td>
                    <td className="py-1 px-2 text-right font-mono text-[#64748b]">&lt;None&gt;</td>
                  </tr>
                  <tr className="border-b border-[#f0f0f0]">
                    <td className="py-1 px-2 text-[#333333]">View Anchor</td>
                    <td className="py-1 px-2 text-right text-[#111827]">View Origin</td>
                  </tr>
                  <tr className="border-b border-[#f0f0f0]">
                    <td className="py-1 px-2 text-[#333333]">View Position X</td>
                    <td className="py-1 px-2 text-right font-mono text-[#111827]">2' 0 211/256"</td>
                  </tr>
                  <tr className="border-b border-[#f0f0f0]">
                    <td className="py-1 px-2 text-[#333333]">View Position Y</td>
                    <td className="py-1 px-2 text-right font-mono text-[#111827]">1' 3 71/256"</td>
                  </tr>
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
