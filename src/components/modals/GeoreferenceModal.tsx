import React, { useState } from 'react';
import { Globe, X, Check, Compass } from 'lucide-react';
import { useBimStore } from '../../store/useBimStore';

export const GeoreferenceModal: React.FC = () => {
  const {
    isGeoreferenceModalOpen,
    setGeoreferenceModalOpen,
    georeference,
    updateGeoreferencing,
  } = useBimStore();

  const [crs, setCrs] = useState(georeference.projected_crs);
  const [eastings, setEastings] = useState(georeference.eastings);
  const [northings, setNorthings] = useState(georeference.northings);
  const [elevation, setElevation] = useState(georeference.elevation);
  const [trueNorth, setTrueNorth] = useState(georeference.true_north);
  const [scale, setScale] = useState(georeference.scale);

  if (!isGeoreferenceModalOpen) return null;

  const handleSave = () => {
    updateGeoreferencing({
      projected_crs: crs,
      eastings: Number(eastings),
      northings: Number(northings),
      elevation: Number(elevation),
      true_north: Number(trueNorth),
      scale: Number(scale),
    });
    setGeoreferenceModalOpen(false);
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-xs flex items-center justify-center z-50 p-4">
      <div className="bg-[#252526] border border-[#3c3c3c] rounded-lg shadow-2xl w-full max-w-lg text-[#cccccc] text-xs overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2.5 bg-[#2d2d2d] border-b border-[#3c3c3c]">
          <div className="flex items-center space-x-2 font-semibold text-white">
            <Globe size={16} className="text-[#38bdf8]" />
            <span>buildingSMART IFC4 Georeferencing Settings</span>
          </div>
          <button
            onClick={() => setGeoreferenceModalOpen(false)}
            className="p-1 hover:bg-[#3c3c3c] rounded text-[#858585] hover:text-white"
          >
            <X size={15} />
          </button>
        </div>

        {/* Body */}
        <div className="p-4 space-y-4">
          <p className="text-[#9ca3af] text-[11px] leading-relaxed">
            Configure the <strong>IfcProjectedCRS</strong> and <strong>IfcMapConversion</strong> parameters
            according to buildingSMART IFC4 standards. Building geometry remains modeled at local (0,0,0) to prevent
            WebGL floating-point jitter.
          </p>

          <div className="space-y-3">
            <div>
              <label className="block text-[11px] font-semibold text-white mb-1">
                Projected CRS (Coordinate Reference System)
              </label>
              <select
                value={crs}
                onChange={(e) => setCrs(e.target.value)}
                className="w-full bg-[#1e1e1e] border border-[#3c3c3c] rounded px-2.5 py-1.5 text-white focus:outline-none focus:border-[#007acc]"
              >
                <option value="EPSG:2285 - NAD83 / Washington North">EPSG:2285 — NAD83 / Washington North (US Survey Feet)</option>
                <option value="EPSG:3857 - WGS 84 / Pseudo-Mercator">EPSG:3857 — WGS 84 / Pseudo-Mercator</option>
                <option value="EPSG:7856 - GDA2020 / MGA Zone 56">EPSG:7856 — GDA2020 / MGA Zone 56</option>
                <option value="EPSG:25832 - ETRS89 / UTM Zone 32N">EPSG:25832 — ETRS89 / UTM Zone 32N</option>
              </select>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[11px] font-semibold text-white mb-1">
                  Eastings (Real-world X)
                </label>
                <input
                  type="number"
                  value={eastings}
                  onChange={(e) => setEastings(parseFloat(e.target.value))}
                  className="w-full bg-[#1e1e1e] border border-[#3c3c3c] rounded px-2.5 py-1.5 text-white font-mono focus:outline-none focus:border-[#007acc]"
                />
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-white mb-1">
                  Northings (Real-world Y)
                </label>
                <input
                  type="number"
                  value={northings}
                  onChange={(e) => setNorthings(parseFloat(e.target.value))}
                  className="w-full bg-[#1e1e1e] border border-[#3c3c3c] rounded px-2.5 py-1.5 text-white font-mono focus:outline-none focus:border-[#007acc]"
                />
              </div>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="block text-[11px] font-semibold text-white mb-1">
                  Elevation (Z Datum)
                </label>
                <input
                  type="number"
                  value={elevation}
                  onChange={(e) => setElevation(parseFloat(e.target.value))}
                  className="w-full bg-[#1e1e1e] border border-[#3c3c3c] rounded px-2.5 py-1.5 text-white font-mono focus:outline-none focus:border-[#007acc]"
                />
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-white mb-1">
                  True North Angle (°)
                </label>
                <input
                  type="number"
                  value={trueNorth}
                  onChange={(e) => setTrueNorth(parseFloat(e.target.value))}
                  className="w-full bg-[#1e1e1e] border border-[#3c3c3c] rounded px-2.5 py-1.5 text-white font-mono focus:outline-none focus:border-[#007acc]"
                />
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-white mb-1">
                  Scale Factor
                </label>
                <input
                  type="number"
                  step="0.0001"
                  value={scale}
                  onChange={(e) => setScale(parseFloat(e.target.value))}
                  className="w-full bg-[#1e1e1e] border border-[#3c3c3c] rounded px-2.5 py-1.5 text-white font-mono focus:outline-none focus:border-[#007acc]"
                />
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end px-4 py-3 bg-[#2d2d2d] border-t border-[#3c3c3c] space-x-2">
          <button
            onClick={() => setGeoreferenceModalOpen(false)}
            className="px-3 py-1.5 bg-[#3c3c3c] hover:bg-[#4a4a4a] text-white rounded"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            className="flex items-center space-x-1 px-4 py-1.5 bg-[#0284c7] hover:bg-[#0369a1] text-white font-semibold rounded"
          >
            <Check size={14} />
            <span>Apply Georeferencing</span>
          </button>
        </div>
      </div>
    </div>
  );
};
