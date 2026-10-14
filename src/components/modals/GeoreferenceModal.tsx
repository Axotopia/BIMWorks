import React, { useEffect, useState } from 'react';
import { Globe, X, Check, Compass, AlertTriangle } from 'lucide-react';
import { useBimStore } from '../../store/useBimStore';

/** The "not set" sentinel for the CRS select. An empty string is the store's value. */
const UNSET = '';
const CUSTOM = '__custom__';

const PRESETS = [
  { value: 'EPSG:2285 - NAD83 / Washington North', label: 'EPSG:2285 — NAD83 / Washington North (US Survey Feet)' },
  { value: 'EPSG:3857 - WGS 84 / Pseudo-Mercator', label: 'EPSG:3857 — WGS 84 / Pseudo-Mercator' },
  { value: 'EPSG:7856 - GDA2020 / MGA Zone 56', label: 'EPSG:7856 — GDA2020 / MGA Zone 56' },
  { value: 'EPSG:25832 - ETRS89 / UTM Zone 32N', label: 'EPSG:25832 — ETRS89 / UTM Zone 32N' },
];

/**
 * Floor-plan dialog for the project's real-world position.
 *
 * UI-P0-7 fixes two defects that together could write fabricated data into a real
 * IFC file:
 *
 *  1. The form was seeded with a genuine NAD83 / Washington North position
 *     (~1,275,432 E, ~234,568 N) and its `useState` snapshots were only taken at
 *     mount, so the dialog showed that position for every project — and "Apply"
 *     would send it. There was no way to express "this project is not georeferenced".
 *  2. Because the state never re-synced, loading a project that *did* carry a CRS
 *     could show (and re-apply) the stale seed instead of the loaded value.
 *
 * The form now re-syncs every time the dialog opens, an unset CRS is a real,
 * selectable state, and Apply is refused while it is unset so the action cannot
 * silently do nothing.
 */
export const GeoreferenceModal: React.FC = () => {
  const {
    isGeoreferenceModalOpen,
    setGeoreferenceModalOpen,
    georeference,
    updateGeoreferencing,
  } = useBimStore();

  const [crsChoice, setCrsChoice] = useState<string>(UNSET);
  const [customCrs, setCustomCrs] = useState<string>('');
  const [eastings, setEastings] = useState<string>('0');
  const [northings, setNorthings] = useState<string>('0');
  const [elevation, setElevation] = useState<string>('0');
  const [trueNorth, setTrueNorth] = useState<string>('0');
  const [scale, setScale] = useState<string>('1');
  const [error, setError] = useState<string | null>(null);

  // Re-sync on open and whenever the underlying project value changes, rather than
  // snapshotting once at mount. `ViewRangeModal` already does exactly this.
  useEffect(() => {
    if (!isGeoreferenceModalOpen) return;
    const stored = georeference.projected_crs || UNSET;
    if (stored === UNSET) {
      setCrsChoice(UNSET);
      setCustomCrs('');
    } else if (PRESETS.some((p) => p.value === stored)) {
      setCrsChoice(stored);
      setCustomCrs('');
    } else {
      setCrsChoice(CUSTOM);
      setCustomCrs(stored);
    }
    setEastings(String(georeference.eastings ?? 0));
    setNorthings(String(georeference.northings ?? 0));
    setElevation(String(georeference.elevation ?? 0));
    setTrueNorth(String(georeference.true_north ?? 0));
    setScale(String(georeference.scale ?? 1));
    setError(null);
  }, [isGeoreferenceModalOpen, georeference]);

  if (!isGeoreferenceModalOpen) return null;

  const resolvedCrs = crsChoice === CUSTOM ? customCrs.trim() : crsChoice;

  const handleSave = () => {
    if (!resolvedCrs) {
      setError('Choose a CRS before applying, or leave georeferencing unset to write no IfcMapConversion.');
      return;
    }
    // Empty numeric fields parse to NaN, which would serialize as null. Fall back
    // to 0 (and 1 for scale) so a cleared box cannot poison the file.
    const num = (text: string, fallback = 0) => {
      const parsed = Number.parseFloat(text);
      return Number.isFinite(parsed) ? parsed : fallback;
    };
    updateGeoreferencing({
      projected_crs: resolvedCrs,
      eastings: num(eastings),
      northings: num(northings),
      elevation: num(elevation),
      true_north: num(trueNorth),
      scale: num(scale, 1),
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
                value={crsChoice}
                onChange={(e) => {
                  setCrsChoice(e.target.value);
                  setError(null);
                }}
                className="w-full bg-[#1e1e1e] border border-[#3c3c3c] rounded px-2.5 py-1.5 text-white focus:outline-none focus:border-[#007acc]"
              >
                <option value={UNSET}>Not set — no georeferencing in the file</option>
                {PRESETS.map((preset) => (
                  <option key={preset.value} value={preset.value}>
                    {preset.label}
                  </option>
                ))}
                <option value={CUSTOM}>Custom CRS name…</option>
              </select>
            </div>

            {crsChoice === CUSTOM && (
              <div>
                <label className="block text-[11px] font-semibold text-white mb-1">
                  Custom CRS name
                </label>
                <input
                  type="text"
                  value={customCrs}
                  placeholder="e.g. EPSG:26910 - NAD83 / UTM zone 10N"
                  onChange={(e) => {
                    setCustomCrs(e.target.value);
                    setError(null);
                  }}
                  className="w-full bg-[#1e1e1e] border border-[#3c3c3c] rounded px-2.5 py-1.5 text-white font-mono focus:outline-none focus:border-[#007acc]"
                />
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[11px] font-semibold text-white mb-1">
                  Eastings (Real-world X)
                </label>
                <input
                  type="number"
                  value={eastings}
                  disabled={!resolvedCrs}
                  onChange={(e) => setEastings(e.target.value)}
                  className="w-full bg-[#1e1e1e] border border-[#3c3c3c] rounded px-2.5 py-1.5 text-white font-mono focus:outline-none focus:border-[#007acc] disabled:opacity-40"
                />
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-white mb-1">
                  Northings (Real-world Y)
                </label>
                <input
                  type="number"
                  value={northings}
                  disabled={!resolvedCrs}
                  onChange={(e) => setNorthings(e.target.value)}
                  className="w-full bg-[#1e1e1e] border border-[#3c3c3c] rounded px-2.5 py-1.5 text-white font-mono focus:outline-none focus:border-[#007acc] disabled:opacity-40"
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
                  disabled={!resolvedCrs}
                  onChange={(e) => setElevation(e.target.value)}
                  className="w-full bg-[#1e1e1e] border border-[#3c3c3c] rounded px-2.5 py-1.5 text-white font-mono focus:outline-none focus:border-[#007acc] disabled:opacity-40"
                />
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-white mb-1">
                  True North Angle (°)
                </label>
                <input
                  type="number"
                  value={trueNorth}
                  disabled={!resolvedCrs}
                  onChange={(e) => setTrueNorth(e.target.value)}
                  className="w-full bg-[#1e1e1e] border border-[#3c3c3c] rounded px-2.5 py-1.5 text-white font-mono focus:outline-none focus:border-[#007acc] disabled:opacity-40"
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
                  disabled={!resolvedCrs}
                  onChange={(e) => setScale(e.target.value)}
                  className="w-full bg-[#1e1e1e] border border-[#3c3c3c] rounded px-2.5 py-1.5 text-white font-mono focus:outline-none focus:border-[#007acc] disabled:opacity-40"
                />
              </div>
            </div>

            {!resolvedCrs && (
              <div className="flex items-start space-x-2 px-3 py-2 bg-[#1e293b] border border-[#334155] rounded text-[11px] text-[#94a3b8]">
                <Compass size={13} className="text-[#64748b] mt-0.5 flex-shrink-0" />
                <span>
                  This project is not georeferenced. It will save with no{' '}
                  <code className="text-[#cbd5e1]">IfcProjectedCRS</code> or{' '}
                  <code className="text-[#cbd5e1]">IfcMapConversion</code>, which is the honest state for a
                  building with no surveyed position.
                </span>
              </div>
            )}

            {error && (
              <div className="flex items-start space-x-2 px-3 py-2 bg-[#450a0a] border border-[#ef4444] rounded text-[11px] text-red-200">
                <AlertTriangle size={13} className="text-[#f87171] mt-0.5 flex-shrink-0" />
                <span>{error}</span>
              </div>
            )}
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
            disabled={!resolvedCrs}
            className="flex items-center space-x-1 px-4 py-1.5 bg-[#0284c7] hover:bg-[#0369a1] text-white font-semibold rounded disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Check size={14} />
            <span>Apply Georeferencing</span>
          </button>
        </div>
      </div>
    </div>
  );
};
