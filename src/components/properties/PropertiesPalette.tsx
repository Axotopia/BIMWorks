import React, { useState, useEffect } from 'react';
import {
  Settings,
  Trash2,
  Box,
  Info,
  Check,
  Move,
  ArrowUpRight,
  Maximize2,
  RotateCcw,
  PenTool,
  X,
  AlertCircle,
  Sparkles,
} from 'lucide-react';
import { useBimStore } from '../../store/useBimStore';
import { formatLength, formatArea, formatVolume } from '../../utils/units';

/** Nudge step in the engine's internal unit (decimal feet): 6 inches. */
const NUDGE_FT = 0.5;
import { measureMesh } from '../../utils/geometry';

export const PropertiesPalette: React.FC = () => {
  const {
    selectedGuid,
    meshes,
    deleteElement,
    updateElement,
    translateElement,
    setEditTypeModalOpen,
    displayUnit,
    views,
    activeViewId,
    activeScale,
    activeDetailLevel,
    sketchSession,
    startSketchMode,
    finishSketchMode,
    cancelSketchMode,
    updateSketchLine,
    deleteSelectedSketchLine,
    setSketchParam,
  } = useBimStore();

  const selectedMesh = meshes.find((m) => m.guid === selectedGuid);
  const activeView = views.find((v) => v.id === activeViewId);

  // The engine's parametric record for this element (baseline, host, type data).
  // Absent on a foreign IFC import, which is why every row below is optional.
  const params = selectedMesh?.params;

  // Area/Volume are measured from the tessellated surface, never hardcoded.
  const measure = selectedMesh ? measureMesh(selectedMesh) : null;
  const isElementSelected = Boolean(selectedMesh);

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

  const isRoof =
    selectedMesh?.ifc_class === 'IfcRoof' ||
    (selectedMesh?.name || '').toLowerCase().includes('roof');
  const isWall =
    selectedMesh?.ifc_class === 'IfcWall' ||
    selectedMesh?.ifc_class === 'IfcWallStandardCase';
  const isSlab =
    selectedMesh?.ifc_class === 'IfcSlab' && !isRoof;
  const isDoor = selectedMesh?.ifc_class === 'IfcDoor';
  const isWindow = selectedMesh?.ifc_class === 'IfcWindow';

  // Nudge / translation helper
  const handleNudge = async (dx: number, dy: number, dz: number) => {
    if (!selectedGuid) return;
    await translateElement(selectedGuid, dx, dy, dz);
  };

  return (
    <div className="h-full w-full bg-[#252526] text-[#cccccc] flex flex-col border-l border-[#3c3c3c] select-none text-xs overflow-hidden">
      {/* Title */}
      <div className="flex items-center justify-between px-3 py-2 bg-[#2d2d2d] border-b border-[#3c3c3c] font-semibold text-[#e1e1e1]">
        <span>Properties</span>
        <button
          onClick={() => setEditTypeModalOpen(true)}
          className="text-[11px] px-2 py-0.5 bg-[#3c3c3c] hover:bg-[#4a4a4a] text-white rounded border border-[#555555]"
        >
          Edit Type
        </button>
      </div>

      {/* Type Selector Dropdown */}
      <div className="p-2 border-b border-[#3c3c3c] bg-[#1e1e1e]">
        <div className="text-[10px] text-[#858585] mb-1 uppercase font-semibold">Type Selector</div>
        <div className="flex items-center space-x-2 bg-[#2a2d2e] border border-[#3c3c3c] rounded px-2 py-1.5">
          <Box size={14} className="text-[#38bdf8]" />
          <div className="flex-1 overflow-hidden">
            <div className="font-semibold text-white truncate text-[11px]">
              {isElementSelected ? selectedMesh?.name : 'Floor Plan : Architectural'}
            </div>
            <div className="text-[10px] text-[#858585] truncate">
              {isElementSelected ? selectedMesh?.ifc_class : 'View Properties'}
            </div>
          </div>
        </div>
      </div>

      {/* Parameter Table */}
      <div className="flex-1 overflow-y-auto p-2 space-y-3">
        {/* Sketch mode takes over the palette while a session is open. */}
        {sketchSession ? (
          <div className="space-y-3">
            {/* Active Sketch Mode Banner */}
            <div className="bg-[#14532d]/40 border border-[#22c55e] p-3 rounded shadow-sm">
              <div className="flex items-center space-x-1.5 text-[#4ade80] font-bold text-xs uppercase tracking-wide mb-1">
                <Sparkles size={14} />
                <span>
                  {sketchSession.mode === 'roof' ? 'Roof Footprint Sketch' : 'Floor Boundary Sketch'}
                </span>
              </div>
              <p className="text-[11px] text-[#bbf7d0] mb-3">
                {sketchSession.isEditingExisting
                  ? `Editing geometry of ${sketchSession.targetName || 'element'}. Draw/modify magenta boundary lines.`
                  : 'Draw closed magenta boundary loop using Line, Rectangle, or Pick Walls.'}
              </p>

              <div className="flex items-center space-x-2">
                <button
                  onClick={() => finishSketchMode()}
                  className="flex-1 flex items-center justify-center space-x-1 py-1.5 bg-[#166534] hover:bg-[#15803d] border border-[#22c55e] text-white rounded text-xs font-semibold shadow"
                >
                  <Check size={14} />
                  <span>Finish (Enter)</span>
                </button>
                <button
                  onClick={() => cancelSketchMode()}
                  className="flex-1 flex items-center justify-center space-x-1 py-1.5 bg-[#7f1d1d] hover:bg-[#991b1b] border border-[#ef4444] text-white rounded text-xs font-semibold shadow"
                >
                  <X size={14} />
                  <span>Cancel (Esc)</span>
                </button>
              </div>

              {sketchSession.validationError && (
                <div className="mt-2.5 p-2 bg-[#450a0a] border border-[#ef4444] rounded text-red-200 text-xs flex items-start space-x-1.5">
                  <AlertCircle size={14} className="text-[#f87171] flex-shrink-0 mt-0.5" />
                  <span>{sketchSession.validationError}</span>
                </div>
              )}
            </div>

            {/* Sketch Session Parameters */}
            <div className="bg-[#1e1e1e] border border-[#3c3c3c] p-3 rounded space-y-2.5 text-xs">
              <div className="text-[10px] uppercase font-bold text-[#94a3b8] tracking-wider">
                Sketch Parameters
              </div>

              {sketchSession.mode === 'roof' ? (
                <>
                  <div>
                    <label className="text-[10px] text-slate-300 block mb-1">Base Elevation (ft)</label>
                    <input
                      type="number"
                      step="0.1"
                      value={sketchSession.elevation}
                      onChange={(e) => setSketchParam('elevation', parseFloat(e.target.value) || 0)}
                      className="w-full bg-[#2a2d2e] border border-[#3c3c3c] rounded px-2 py-1 text-white text-xs"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] text-slate-300 block mb-1">Roof Thickness (in)</label>
                    <input
                      type="number"
                      step="0.05"
                      value={sketchSession.thickness}
                      onChange={(e) => setSketchParam('thickness', parseFloat(e.target.value) || 0.3)}
                      className="w-full bg-[#2a2d2e] border border-[#3c3c3c] rounded px-2 py-1 text-white text-xs"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] text-slate-300 block mb-1">Slope Pitch (degrees)</label>
                    <input
                      type="number"
                      step="0.5"
                      value={sketchSession.pitch}
                      onChange={(e) => {
                        const val = parseFloat(e.target.value) || 0;
                        setSketchParam('pitch', val);
                        setSketchParam('defaultSlopeAngle', val);
                      }}
                      className="w-full bg-[#2a2d2e] border border-[#3c3c3c] rounded px-2 py-1 text-white text-xs"
                    />
                  </div>
                </>
              ) : (
                <>
                  <div>
                    <label className="text-[10px] text-slate-300 block mb-1">Elevation from Level (ft)</label>
                    <input
                      type="number"
                      step="0.1"
                      value={sketchSession.elevation}
                      onChange={(e) => setSketchParam('elevation', parseFloat(e.target.value) || 0)}
                      className="w-full bg-[#2a2d2e] border border-[#3c3c3c] rounded px-2 py-1 text-white text-xs"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] text-slate-300 block mb-1">Floor Slab Thickness (in)</label>
                    <input
                      type="number"
                      step="0.05"
                      value={sketchSession.thickness}
                      onChange={(e) => setSketchParam('thickness', parseFloat(e.target.value) || 0.25)}
                      className="w-full bg-[#2a2d2e] border border-[#3c3c3c] rounded px-2 py-1 text-white text-xs"
                    />
                  </div>
                </>
              )}
            </div>

            {/* Selected Sketch Line Properties */}
            {sketchSession.selectedLineId && (() => {
              const selLine = sketchSession.lines.find((l) => l.id === sketchSession.selectedLineId);
              if (!selLine) return null;
              const len = Math.hypot(selLine.end[0] - selLine.start[0], selLine.end[1] - selLine.start[1]);
              return (
                <div className="bg-[#1f2937] border border-[#38bdf8]/40 p-3 rounded space-y-2 text-xs">
                  <div className="flex items-center justify-between text-[#38bdf8] font-bold text-[10px] uppercase">
                    <span>Selected Boundary Line</span>
                    <button
                      onClick={() => deleteSelectedSketchLine()}
                      className="text-red-400 hover:text-red-300 p-0.5"
                      title="Delete Line"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                  <div className="text-[11px] text-slate-300">
                    Length: <span className="text-white font-mono">{len.toFixed(2)}'</span>
                  </div>
                  {sketchSession.mode === 'roof' && (
                    <label className="flex items-center space-x-2 cursor-pointer mt-1">
                      <input
                        type="checkbox"
                        checked={Boolean(selLine.definesSlope)}
                        onChange={(e) => updateSketchLine(selLine.id, { definesSlope: e.target.checked })}
                        className="rounded bg-[#2a2d2e] border-[#555555] text-[#007acc]"
                      />
                      <span className="text-white text-xs">Defines Roof Slope</span>
                    </label>
                  )}
                </div>
              );
            })()}
          </div>
        ) : isElementSelected ? (
          <>
            {/* Constraints Group.
                No constraint/level-driver plumbing exists yet, so these rows
                report only what the engine actually tracks ("—" otherwise)
                instead of printing Revit-looking defaults for every element. */}
            <div>
              <div className="text-[10px] uppercase font-bold text-[#969696] mb-1 tracking-wider border-b border-[#333333] pb-0.5">
                Constraints
              </div>
              <table className="w-full text-[11px]">
                <tbody>
                  <tr className="border-b border-[#2d2d2d]">
                    <td className="py-1 text-[#858585]">Base Level</td>
                    <td className="py-1 text-right text-white font-mono">{params?.level_id ?? '—'}</td>
                  </tr>
                  <tr className="border-b border-[#2d2d2d]">
                    <td className="py-1 text-[#858585]">Base Constraint</td>
                    <td className="py-1 text-right text-[#858585] font-mono">Not tracked</td>
                  </tr>
                  <tr className="border-b border-[#2d2d2d]">
                    <td className="py-1 text-[#858585]">Top Constraint</td>
                    <td className="py-1 text-right text-[#858585] font-mono">Not tracked</td>
                  </tr>
                  <tr className="border-b border-[#2d2d2d]">
                    <td className="py-1 text-[#858585]">Unconnected Height</td>
                    <td className="py-1 text-right text-white font-mono">
                      {typeof params?.height === 'number'
                        ? formatLength(params.height, displayUnit)
                        : '—'}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            {/* Dimensions Group — measured from the tessellated surface */}
            <div>
              <div className="text-[10px] uppercase font-bold text-[#969696] mb-1 tracking-wider border-b border-[#333333] pb-0.5">
                Dimensions
              </div>
              <table className="w-full text-[11px]">
                <tbody>
                  <tr className="border-b border-[#2d2d2d]">
                    <td className="py-1 text-[#858585]">Length</td>
                    <td className="py-1 text-right text-[#38bdf8] font-mono">
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
                  <tr className="border-b border-[#2d2d2d]">
                    <td className="py-1 text-[#858585]">Area</td>
                    <td className="py-1 text-right text-[#38bdf8] font-mono">
                      {measure ? formatArea(measure.areaFt2, displayUnit) : '—'}
                    </td>
                  </tr>
                  <tr className="border-b border-[#2d2d2d]">
                    <td className="py-1 text-[#858585]">Volume</td>
                    <td className="py-1 text-right text-[#38bdf8] font-mono">
                      {measure ? formatVolume(measure.volumeFt3, displayUnit) : '—'}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            {/* IFC & Identity Data */}
            <div>
              <div className="text-[10px] uppercase font-bold text-[#969696] mb-1 tracking-wider border-b border-[#333333] pb-0.5">
                Identity &amp; IFC Data
              </div>
              <table className="w-full text-[11px]">
                <tbody>
                  <tr className="border-b border-[#2d2d2d]">
                    <td className="py-1 text-[#858585]">IFC Class</td>
                    <td className="py-1 text-right text-white font-mono">{selectedMesh?.ifc_class}</td>
                  </tr>
                  <tr className="border-b border-[#2d2d2d]">
                    <td className="py-1 text-[#858585]">IFC GUID</td>
                    <td className="py-1 text-right text-[#9ca3af] font-mono text-[9px] truncate max-w-[120px]">
                      {selectedMesh?.guid}
                    </td>
                  </tr>
                  <tr className="border-b border-[#2d2d2d]">
                    <td className="py-1 text-[#858585]">Phase Created</td>
                    <td className="py-1 text-right text-[#858585] font-mono">Not tracked</td>
                  </tr>
                </tbody>
              </table>
            </div>

            {/* Quick Actions */}
            <div className="pt-2">
              <button
                onClick={() => selectedGuid && deleteElement(selectedGuid)}
                className="w-full flex items-center justify-center space-x-1.5 py-1.5 bg-[#451a1a] hover:bg-[#6b2121] text-[#fca5a5] rounded border border-[#7f1d1d] text-xs font-medium"
              >
                <Trash2 size={13} />
                <span>Delete Element</span>
              </button>
            </div>
            {/* Revit Sketch Mode Trigger */}
            {(isSlab || isRoof) && (
              <button
                onClick={() => startSketchMode(isRoof ? 'roof' : 'floor', selectedGuid || undefined)}
                className="w-full flex items-center justify-center space-x-2 py-2 px-3 bg-[#0e703c] hover:bg-[#15803d] border border-[#22c55e] text-white rounded font-bold text-xs shadow-md transition-all group mb-2"
                title={`Enter Sketch Mode to modify 2D boundary of this ${isRoof ? 'roof' : 'floor'}`}
              >
                <PenTool size={15} className="text-[#86efac] group-hover:scale-110 transition-transform" />
                <span>{isRoof ? 'Edit Footprint (Sketch Mode)' : 'Edit Boundary (Sketch Mode)'}</span>
              </button>
            )}

            {/* Bonsai-Style Live Geometry & Slope Editor */}
            <div className="bg-[#1f242d] p-2.5 rounded border border-[#0284c7]/40 shadow-sm">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] uppercase font-bold text-[#38bdf8] tracking-wider flex items-center space-x-1">
                  <ArrowUpRight size={12} />
                  <span>Geometry &amp; Shape Editor</span>
                </span>
                {saveSuccess && (
                  <span className="text-[10px] text-emerald-400 font-semibold flex items-center space-x-0.5 animate-pulse">
                    <Check size={11} />
                    <span>Applied!</span>
                  </span>
                )}
              </div>

              {/* ROOF PARAMETERS */}
              {isRoof && (
                <div className="space-y-2">
                  <div>
                    <label className="text-[10px] text-slate-300 block mb-0.5 font-medium">
                      Roof Pitch / Slope (Degrees)
                    </label>
                    <div className="flex items-center space-x-1.5">
                      <input
                        type="number"
                        step="0.5"
                        value={formPitch}
                        onChange={(e) => setFormPitch(e.target.value)}
                        className="w-20 px-2 py-1 bg-[#111827] text-white rounded border border-slate-600 font-mono text-xs focus:border-[#38bdf8] outline-none"
                      />
                      <span className="text-slate-400 font-mono text-xs">deg (°)</span>
                    </div>

                    {/* Quick Preset Pills */}
                    <div className="flex flex-wrap gap-1 mt-1.5">
                      {[
                        { label: '0° Flat', val: 0.0 },
                        { label: '10° Low', val: 10.0 },
                        { label: '4:12 (18.4°)', val: 18.4 },
                        { label: '6:12 (26.6°)', val: 26.6 },
                        { label: '8:12 (33.7°)', val: 33.7 },
                      ].map((preset) => (
                        <button
                          key={preset.label}
                          onClick={() => {
                            setFormPitch(preset.val.toString());
                            updateElement(selectedGuid!, { pitch: preset.val });
                          }}
                          className={`text-[9px] px-1.5 py-0.5 rounded border font-mono ${
                            Math.abs(parseFloat(formPitch) - preset.val) < 0.5
                              ? 'bg-[#0284c7] text-white border-[#38bdf8]'
                              : 'bg-[#1e293b] text-slate-300 border-slate-700 hover:bg-[#334155]'
                          }`}
                        >
                          {preset.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-2 pt-1">
                    <div>
                      <label className="text-[10px] text-slate-300 block mb-0.5 font-medium">Plate Elevation (ft)</label>
                      <input
                        type="number"
                        step="0.25"
                        value={formElevation}
                        onChange={(e) => setFormElevation(e.target.value)}
                        className="w-full px-2 py-1 bg-[#111827] text-white rounded border border-slate-600 font-mono text-xs"
                      />
                    </div>
                    <div>
                      <label className="text-[10px] text-slate-300 block mb-0.5 font-medium">Thickness (ft)</label>
                      <input
                        type="number"
                        step="0.05"
                        value={formThickness}
                        onChange={(e) => setFormThickness(e.target.value)}
                        className="w-full px-2 py-1 bg-[#111827] text-white rounded border border-slate-600 font-mono text-xs"
                      />
                    </div>
                  </div>

                  {/* Overhang Quick Nudges */}
                  <div>
                    <label className="text-[10px] text-slate-300 block mb-0.5 font-medium">Eave Overhang Offset</label>
                    <div className="flex space-x-1">
                      <button
                        onClick={() => {
                          const factor = 1.05; // 5% expansion
                          if (formPolygon.length > 0) {
                            const cx = formPolygon.reduce((s, p) => s + p[0], 0) / formPolygon.length;
                            const cy = formPolygon.reduce((s, p) => s + p[1], 0) / formPolygon.length;
                            const expanded = formPolygon.map(
                              ([x, y]) => [cx + (x - cx) * factor, cy + (y - cy) * factor] as [number, number]
                            );
                            setFormPolygon(expanded);
                            updateElement(selectedGuid!, { polygon: expanded });
                          }
                        }}
                        className="flex-1 py-1 bg-[#1e293b] hover:bg-[#334155] text-slate-200 rounded border border-slate-700 text-[10px] font-mono"
                      >
                        + 1'-0" (0.3m)
                      </button>
                      <button
                        onClick={() => {
                          const factor = 0.95;
                          if (formPolygon.length > 0) {
                            const cx = formPolygon.reduce((s, p) => s + p[0], 0) / formPolygon.length;
                            const cy = formPolygon.reduce((s, p) => s + p[1], 0) / formPolygon.length;
                            const contracted = formPolygon.map(
                              ([x, y]) => [cx + (x - cx) * factor, cy + (y - cy) * factor] as [number, number]
                            );
                            setFormPolygon(contracted);
                            updateElement(selectedGuid!, { polygon: contracted });
                          }
                        }}
                        className="flex-1 py-1 bg-[#1e293b] hover:bg-[#334155] text-slate-200 rounded border border-slate-700 text-[10px] font-mono"
                      >
                        - 1'-0" (0.3m)
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* WALL PARAMETERS */}
              {isWall && (
                <div className="space-y-2">
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="text-[10px] text-slate-300 block mb-0.5 font-medium">Wall Height (m)</label>
                      <input
                        type="number"
                        step="0.1"
                        value={formHeight}
                        onChange={(e) => setFormHeight(e.target.value)}
                        className="w-full px-2 py-1 bg-[#111827] text-white rounded border border-slate-600 font-mono text-xs"
                      />
                    </div>
                    <div>
                      <label className="text-[10px] text-slate-300 block mb-0.5 font-medium">Thickness (ft)</label>
                      <input
                        type="number"
                        step="0.05"
                        value={formThickness}
                        onChange={(e) => setFormThickness(e.target.value)}
                        className="w-full px-2 py-1 bg-[#111827] text-white rounded border border-slate-600 font-mono text-xs"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="text-[10px] text-slate-300 block mb-0.5 font-medium">Start Point (X, Y)</label>
                    <div className="grid grid-cols-2 gap-1">
                      <input
                        type="number"
                        step="0.1"
                        value={formStartX}
                        onChange={(e) => setFormStartX(e.target.value)}
                        className="px-2 py-1 bg-[#111827] text-white rounded border border-slate-600 font-mono text-xs"
                      />
                      <input
                        type="number"
                        step="0.1"
                        value={formStartY}
                        onChange={(e) => setFormStartY(e.target.value)}
                        className="px-2 py-1 bg-[#111827] text-white rounded border border-slate-600 font-mono text-xs"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="text-[10px] text-slate-300 block mb-0.5 font-medium">End Point (X, Y)</label>
                    <div className="grid grid-cols-2 gap-1">
                      <input
                        type="number"
                        step="0.1"
                        value={formEndX}
                        onChange={(e) => setFormEndX(e.target.value)}
                        className="px-2 py-1 bg-[#111827] text-white rounded border border-slate-600 font-mono text-xs"
                      />
                      <input
                        type="number"
                        step="0.1"
                        value={formEndY}
                        onChange={(e) => setFormEndY(e.target.value)}
                        className="px-2 py-1 bg-[#111827] text-white rounded border border-slate-600 font-mono text-xs"
                      />
                    </div>
                  </div>
                </div>
              )}

              {/* FLOOR SLAB PARAMETERS */}
              {isSlab && (
                <div className="space-y-2">
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="text-[10px] text-slate-300 block mb-0.5 font-medium">Elevation (ft)</label>
                      <input
                        type="number"
                        step="0.1"
                        value={formElevation}
                        onChange={(e) => setFormElevation(e.target.value)}
                        className="w-full px-2 py-1 bg-[#111827] text-white rounded border border-slate-600 font-mono text-xs"
                      />
                    </div>
                    <div>
                      <label className="text-[10px] text-slate-300 block mb-0.5 font-medium">Thickness (ft)</label>
                      <input
                        type="number"
                        step="0.05"
                        value={formThickness}
                        onChange={(e) => setFormThickness(e.target.value)}
                        className="w-full px-2 py-1 bg-[#111827] text-white rounded border border-slate-600 font-mono text-xs"
                      />
                    </div>
                  </div>
                </div>
              )}

              {/* DOOR / WINDOW PARAMETERS */}
              {(isDoor || isWindow) && (
                <div className="space-y-2">
                  <div>
                    <label className="text-[10px] text-slate-300 block mb-0.5 font-medium">
                      Offset Along Wall (m)
                    </label>
                    <input
                      type="number"
                      step="0.1"
                      value={formOffset}
                      onChange={(e) => setFormOffset(e.target.value)}
                      className="w-full px-2 py-1 bg-[#111827] text-white rounded border border-slate-600 font-mono text-xs"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="text-[10px] text-slate-300 block mb-0.5 font-medium">Width (m)</label>
                      <input
                        type="number"
                        step="0.05"
                        value={formWidth}
                        onChange={(e) => setFormWidth(e.target.value)}
                        className="w-full px-2 py-1 bg-[#111827] text-white rounded border border-slate-600 font-mono text-xs"
                      />
                    </div>
                    {isDoor && (
                      <div className="flex items-end">
                        <button
                          onClick={() => {
                            const flipped = !elementData?.swing_flipped;
                            updateElement(selectedGuid!, { swing_flipped: flipped });
                          }}
                          className="w-full py-1 bg-[#1e293b] hover:bg-[#334155] text-slate-200 rounded border border-slate-700 text-[10px]"
                        >
                          Flip Swing
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Apply Changes Button */}
              <button
                onClick={handleApplyChanges}
                className="mt-3 w-full py-1.5 bg-[#0284c7] hover:bg-[#0369a1] text-white rounded font-medium text-xs shadow flex items-center justify-center space-x-1"
              >
                <Check size={13} />
                <span>Apply Geometry Changes</span>
              </button>
            </div>

            {/* Translation / Nudge Controls */}
            <div className="bg-[#1e1e1e] p-2 rounded border border-[#333333]">
              <div className="text-[10px] uppercase font-bold text-[#858585] mb-1.5 flex items-center space-x-1">
                <Move size={12} />
                <span>Spatial Translation / Move</span>
              </div>
              <div className="grid grid-cols-3 gap-1 text-[10px] font-mono">
                <button
                  onClick={() => handleNudge(-NUDGE_FT, 0, 0)}
                  className="py-1 bg-[#2a2d2e] hover:bg-[#3c3c3c] text-white rounded border border-[#444]"
                >
                  -X (6")
                </button>
                <button
                  onClick={() => handleNudge(0, NUDGE_FT, 0)}
                  className="py-1 bg-[#2a2d2e] hover:bg-[#3c3c3c] text-white rounded border border-[#444]"
                >
                  +Y (6")
                </button>
                <button
                  onClick={() => handleNudge(NUDGE_FT, 0, 0)}
                  className="py-1 bg-[#2a2d2e] hover:bg-[#3c3c3c] text-white rounded border border-[#444]"
                >
                  +X (6")
                </button>
                <button
                  onClick={() => handleNudge(0, 0, -NUDGE_FT)}
                  className="py-1 bg-[#2a2d2e] hover:bg-[#3c3c3c] text-white rounded border border-[#444]"
                >
                  -Z (Down)
                </button>
                <button
                  onClick={() => handleNudge(0, -NUDGE_FT, 0)}
                  className="py-1 bg-[#2a2d2e] hover:bg-[#3c3c3c] text-white rounded border border-[#444]"
                >
                  -Y (6")
                </button>
                <button
                  onClick={() => handleNudge(0, 0, NUDGE_FT)}
                  className="py-1 bg-[#2a2d2e] hover:bg-[#3c3c3c] text-white rounded border border-[#444]"
                >
                  +Z (Up)
                </button>
              </div>
            </div>

              {/* IFC & Identity Data */}
              <div>
                <div className="text-[10px] uppercase font-bold text-[#969696] mb-1 tracking-wider border-b border-[#333333] pb-0.5">
                  Identity &amp; IFC Data
                </div>
                <table className="w-full text-[11px]">
                  <tbody>
                    <tr className="border-b border-[#2d2d2d]">
                      <td className="py-1 text-[#858585]">IFC Class</td>
                      <td className="py-1 text-right text-white font-mono">{selectedMesh?.ifc_class}</td>
                    </tr>
                    <tr className="border-b border-[#2d2d2d]">
                      <td className="py-1 text-[#858585]">IFC GUID</td>
                      <td className="py-1 text-right text-[#9ca3af] font-mono text-[9px] truncate max-w-[120px]">
                        {selectedMesh?.guid}
                      </td>
                    </tr>
                    <tr className="border-b border-[#2d2d2d]">
                      <td className="py-1 text-[#858585]">Phase Created</td>
                      <td className="py-1 text-right text-[#858585] font-mono">Not tracked</td>
                    </tr>
                  </tbody>
                </table>
              </div>

              {/* Quick Actions */}
              <div className="pt-2">
                <button
                  onClick={() => selectedGuid && deleteElement(selectedGuid)}
                  className="w-full flex items-center justify-center space-x-1.5 py-1.5 bg-[#451a1a] hover:bg-[#6b2121] text-[#fca5a5] rounded border border-[#7f1d1d] text-xs font-medium"
                >
                  <Trash2 size={13} />
                  <span>Delete Element</span>
                </button>
              </div>
          </>
        ) : (
          /* View Properties when nothing is selected — read from the active view */
          <div>
            <div className="text-[10px] uppercase font-bold text-[#969696] mb-1 tracking-wider border-b border-[#333333] pb-0.5">
              Graphics &amp; Extents
            </div>
            <table className="w-full text-[11px]">
              <tbody>
                <tr className="border-b border-[#2d2d2d]">
                  <td className="py-1 text-[#858585]">View Name</td>
                  <td className="py-1 text-right text-white font-mono">{activeView?.name ?? '—'}</td>
                </tr>
                <tr className="border-b border-[#2d2d2d]">
                  <td className="py-1 text-[#858585]">View Scale</td>
                  <td className="py-1 text-right text-white font-mono">{activeScale}</td>
                </tr>
                <tr className="border-b border-[#2d2d2d]">
                  <td className="py-1 text-[#858585]">Detail Level</td>
                  <td className="py-1 text-right text-white capitalize">{activeDetailLevel}</td>
                </tr>
                <tr className="border-b border-[#2d2d2d]">
                  <td className="py-1 text-[#858585]">Discipline</td>
                  <td className="py-1 text-right text-white">Architectural</td>
                </tr>
                <tr className="border-b border-[#2d2d2d]">
                  <td className="py-1 text-[#858585]">View Range — Cut Plane</td>
                  <td className="py-1 text-right text-[#38bdf8] font-mono">
                    {activeView
                      ? formatLength(
                          activeView.viewRange?.cut ??
                            (activeView as any)?.view_range?.cut ??
                            4.0,
                          displayUnit
                        )
                      : '—'}
                  </td>
                </tr>
              </tbody>
            </table>
            <div className="mt-4 p-2 bg-[#1e1e1e] rounded border border-[#333333] text-[11px] text-[#858585] flex items-start space-x-2">
              <Info size={14} className="text-[#38bdf8] mt-0.5 shrink-0" />
              <span>Select an architectural element (wall, door, window) in the viewport to view its IFC parameters.</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
