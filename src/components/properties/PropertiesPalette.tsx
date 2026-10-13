import React from 'react';
import { Settings, Trash2, Box, Info } from 'lucide-react';
import { useBimStore } from '../../store/useBimStore';

export const PropertiesPalette: React.FC = () => {
  const {
    selectedGuid,
    meshes,
    deleteElement,
    setEditTypeModalOpen,
  } = useBimStore();

  const selectedMesh = meshes.find((m) => m.guid === selectedGuid);

  // Default values when nothing is selected (shows View Properties)
  const isElementSelected = Boolean(selectedMesh);

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
        {isElementSelected ? (
          <>
            {/* Constraints Group */}
            <div>
              <div className="text-[10px] uppercase font-bold text-[#969696] mb-1 tracking-wider border-b border-[#333333] pb-0.5">
                Constraints
              </div>
              <table className="w-full text-[11px]">
                <tbody>
                  <tr className="border-b border-[#2d2d2d]">
                    <td className="py-1 text-[#858585]">Base Constraint</td>
                    <td className="py-1 text-right text-white font-mono">Level 1</td>
                  </tr>
                  <tr className="border-b border-[#2d2d2d]">
                    <td className="py-1 text-[#858585]">Base Offset</td>
                    <td className="py-1 text-right text-white font-mono">0'-0" (0 mm)</td>
                  </tr>
                  <tr className="border-b border-[#2d2d2d]">
                    <td className="py-1 text-[#858585]">Top Constraint</td>
                    <td className="py-1 text-right text-white font-mono">Up to Level 2</td>
                  </tr>
                  <tr className="border-b border-[#2d2d2d]">
                    <td className="py-1 text-[#858585]">Unconnected Height</td>
                    <td className="py-1 text-right text-white font-mono">10'-0" (3000 mm)</td>
                  </tr>
                </tbody>
              </table>
            </div>

            {/* Dimensions Group */}
            <div>
              <div className="text-[10px] uppercase font-bold text-[#969696] mb-1 tracking-wider border-b border-[#333333] pb-0.5">
                Dimensions
              </div>
              <table className="w-full text-[11px]">
                <tbody>
                  <tr className="border-b border-[#2d2d2d]">
                    <td className="py-1 text-[#858585]">Length</td>
                    <td className="py-1 text-right text-[#38bdf8] font-mono">
                      {selectedMesh?.bbox
                        ? `${(
                            Math.hypot(
                              selectedMesh.bbox.max[0] - selectedMesh.bbox.min[0],
                              selectedMesh.bbox.max[1] - selectedMesh.bbox.min[1]
                            )
                          ).toFixed(2)} m`
                        : '4.50 m'}
                    </td>
                  </tr>
                  <tr className="border-b border-[#2d2d2d]">
                    <td className="py-1 text-[#858585]">Area</td>
                    <td className="py-1 text-right text-[#38bdf8] font-mono">13.50 m²</td>
                  </tr>
                  <tr className="border-b border-[#2d2d2d]">
                    <td className="py-1 text-[#858585]">Volume</td>
                    <td className="py-1 text-right text-[#38bdf8] font-mono">2.70 m³</td>
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
                    <td className="py-1 text-right text-white">New Construction</td>
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
              <span>Select an architectural element (wall, door, window) in the viewport to view its IFC parameters.</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
