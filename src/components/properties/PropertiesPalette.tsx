import React, { useState, useEffect } from 'react';
import { Settings, Trash2, Box, Info, Check, Move, ArrowUpRight, Maximize2, RotateCcw } from 'lucide-react';
import { useBimStore } from '../../store/useBimStore';
import { formatLength, metersToFeet } from '../../utils/units';

export const PropertiesPalette: React.FC = () => {
  const {
    selectedGuid,
    meshes,
    deleteElement,
    updateElement,
    translateElement,
    setEditTypeModalOpen,
    displayUnit,
  } = useBimStore();

  const selectedMesh = meshes.find((m) => m.guid === selectedGuid);
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

      {/* Parameter Table & Bonsai-Style Geometry Editor */}
      <div className="flex-1 overflow-y-auto p-2 space-y-3">
        {isElementSelected ? (
          <>
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
                      <label className="text-[10px] text-slate-300 block mb-0.5 font-medium">Plate Elevation (m)</label>
                      <input
                        type="number"
                        step="0.25"
                        value={formElevation}
                        onChange={(e) => setFormElevation(e.target.value)}
                        className="w-full px-2 py-1 bg-[#111827] text-white rounded border border-slate-600 font-mono text-xs"
                      />
                    </div>
                    <div>
                      <label className="text-[10px] text-slate-300 block mb-0.5 font-medium">Thickness (m)</label>
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
                      <label className="text-[10px] text-slate-300 block mb-0.5 font-medium">Thickness (m)</label>
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
                      <label className="text-[10px] text-slate-300 block mb-0.5 font-medium">Elevation (m)</label>
                      <input
                        type="number"
                        step="0.1"
                        value={formElevation}
                        onChange={(e) => setFormElevation(e.target.value)}
                        className="w-full px-2 py-1 bg-[#111827] text-white rounded border border-slate-600 font-mono text-xs"
                      />
                    </div>
                    <div>
                      <label className="text-[10px] text-slate-300 block mb-0.5 font-medium">Thickness (m)</label>
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
                  onClick={() => handleNudge(-0.5, 0, 0)}
                  className="py-1 bg-[#2a2d2e] hover:bg-[#3c3c3c] text-white rounded border border-[#444]"
                >
                  -X (0.5m)
                </button>
                <button
                  onClick={() => handleNudge(0, 0.5, 0)}
                  className="py-1 bg-[#2a2d2e] hover:bg-[#3c3c3c] text-white rounded border border-[#444]"
                >
                  +Y (0.5m)
                </button>
                <button
                  onClick={() => handleNudge(0.5, 0, 0)}
                  className="py-1 bg-[#2a2d2e] hover:bg-[#3c3c3c] text-white rounded border border-[#444]"
                >
                  +X (0.5m)
                </button>
                <button
                  onClick={() => handleNudge(0, 0, -0.5)}
                  className="py-1 bg-[#2a2d2e] hover:bg-[#3c3c3c] text-white rounded border border-[#444]"
                >
                  -Z (Down)
                </button>
                <button
                  onClick={() => handleNudge(0, -0.5, 0)}
                  className="py-1 bg-[#2a2d2e] hover:bg-[#3c3c3c] text-white rounded border border-[#444]"
                >
                  -Y (0.5m)
                </button>
                <button
                  onClick={() => handleNudge(0, 0, 0.5)}
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
                    <td className="py-1 text-right text-white">New Construction</td>
                  </tr>
                </tbody>
              </table>
            </div>

            {/* Quick Actions (Delete Element) */}
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
          /* View Properties when nothing is selected */
          <div>
            <div className="text-[10px] uppercase font-bold text-[#969696] mb-1 tracking-wider border-b border-[#333333] pb-0.5">
              Graphics &amp; Extents
            </div>
            <table className="w-full text-[11px]">
              <tbody>
                <tr className="border-b border-[#2d2d2d]">
                  <td className="py-1 text-[#858585]">View Scale</td>
                  <td className="py-1 text-right text-white font-mono">1/4" = 1'-0"</td>
                </tr>
                <tr className="border-b border-[#2d2d2d]">
                  <td className="py-1 text-[#858585]">Detail Level</td>
                  <td className="py-1 text-right text-white">Medium</td>
                </tr>
                <tr className="border-b border-[#2d2d2d]">
                  <td className="py-1 text-[#858585]">Discipline</td>
                  <td className="py-1 text-right text-white">Architectural</td>
                </tr>
                <tr className="border-b border-[#2d2d2d]">
                  <td className="py-1 text-[#858585]">Cut Plane Elevation</td>
                  <td className="py-1 text-right text-[#38bdf8] font-mono">4'-0" (1200 mm)</td>
                </tr>
              </tbody>
            </table>
            <div className="mt-4 p-2 bg-[#1e1e1e] rounded border border-[#333333] text-[11px] text-[#858585] flex items-start space-x-2">
              <Info size={14} className="text-[#38bdf8] mt-0.5 shrink-0" />
              <span>
                Select any roof, wall, or floor to edit slope, pitch, elevation, thickness, and boundary shape.
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
