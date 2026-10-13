import React from 'react';
import {
  Glasses,
  Crop,
  Layers,
  Sun,
  Eye,
  EyeOff,
  Maximize2,
  SlidersHorizontal,
} from 'lucide-react';
import { useBimStore } from '../../store/useBimStore';

export const StatusBar: React.FC = () => {
  const {
    activeScale,
    setScale,
    activeDetailLevel,
    setDetailLevel,
    activeVisualStyle,
    setVisualStyle,
    hiddenGuids,
    isolatedGuids,
    resetTempVisibility,
    tempHideSelected,
    tempIsolateSelected,
    selectedGuid,
    activeTool,
    keyBuffer,
    setViewRangeModalOpen,
  } = useBimStore();

  const isTempActive = hiddenGuids.length > 0 || isolatedGuids.length > 0;

  return (
    <div className="flex items-center justify-between px-3 py-1 bg-[#1e1e1e] border-t border-[#333333] select-none text-[11px] text-[#969696] z-20">
      {/* Left: View Control Bar (Revit View Control Strip) */}
      <div className="flex items-center space-x-2">
        {/* Scale Selector */}
        <select
          value={activeScale}
          onChange={(e) => setScale(e.target.value)}
          className="bg-[#2d2d2d] border border-[#3c3c3c] text-white rounded px-1.5 py-0.5 text-[10px] cursor-pointer focus:outline-none focus:border-[#007acc]"
        >
          <option value='1/8" = 1&apos;-0"'>1/8" = 1'-0"</option>
          <option value='1/4" = 1&apos;-0"'>1/4" = 1'-0"</option>
          <option value='1/2" = 1&apos;-0"'>1/2" = 1'-0"</option>
          <option value="1:100">1:100 (Metric)</option>
          <option value="1:50">1:50 (Metric)</option>
        </select>

        {/* Detail Level */}
        <div className="flex items-center space-x-0.5 bg-[#2d2d2d] border border-[#3c3c3c] rounded p-0.5">
          {(['coarse', 'medium', 'fine'] as const).map((lvl) => (
            <button
              key={lvl}
              onClick={() => setDetailLevel(lvl)}
              className={`px-1.5 py-0.5 rounded capitalize text-[10px] ${
                activeDetailLevel === lvl ? 'bg-[#094771] text-white font-semibold' : 'text-[#858585] hover:text-white'
              }`}
            >
              {lvl}
            </button>
          ))}
        </div>

        {/* Visual Style */}
        <div className="flex items-center space-x-0.5 bg-[#2d2d2d] border border-[#3c3c3c] rounded p-0.5">
          <button
            onClick={() => setVisualStyle('hidden_line')}
            className={`px-1.5 py-0.5 rounded text-[10px] ${
              activeVisualStyle === 'hidden_line' ? 'bg-[#094771] text-white font-semibold' : 'text-[#858585] hover:text-white'
            }`}
            title="Hidden Line"
          >
            HL
          </button>
          <button
            onClick={() => setVisualStyle('consistent_colors')}
            className={`px-1.5 py-0.5 rounded text-[10px] ${
              activeVisualStyle === 'consistent_colors' ? 'bg-[#094771] text-white font-semibold' : 'text-[#858585] hover:text-white'
            }`}
            title="Consistent Colors (Revit Default)"
          >
            CC
          </button>
          <button
            onClick={() => setVisualStyle('wireframe')}
            className={`px-1.5 py-0.5 rounded text-[10px] ${
              activeVisualStyle === 'wireframe' ? 'bg-[#094771] text-white font-semibold' : 'text-[#858585] hover:text-white'
            }`}
            title="Wireframe"
          >
            WF
          </button>
        </div>

        {/* View Range Modal Button */}
        <button
          onClick={() => setViewRangeModalOpen(true)}
          className="p-1 hover:bg-[#333333] rounded text-[#cccccc] hover:text-[#38bdf8] flex items-center space-x-1"
          title="Edit View Range (Top, Cut Plane, Bottom, View Depth)"
        >
          <SlidersHorizontal size={13} />
          <span className="text-[10px] hidden sm:inline">View Range</span>
        </button>

        {/* Temporary Hide/Isolate Glasses (HH, HR, HI) */}
        <div className="relative group">
          <button
            onClick={() => (isTempActive ? resetTempVisibility() : selectedGuid && tempHideSelected())}
            className={`p-1 rounded flex items-center space-x-1 border ${
              isTempActive
                ? 'bg-[#0284c7] text-white border-[#38bdf8] font-bold'
                : 'border-transparent hover:bg-[#333333] text-[#cccccc]'
            }`}
            title="Temporary Hide/Isolate (HH, HI, HR)"
          >
            <Glasses size={14} />
            {isTempActive && <span className="text-[10px]">Active</span>}
          </button>
        </div>
      </div>

      {/* Middle: Active Command Guidance */}
      <div className="text-[#a1a1aa] font-medium hidden lg:flex items-center space-x-2">
        {activeTool !== 'select' ? (
          <span className="text-[#38bdf8] font-semibold animate-pulse">
            Active Command: {activeTool} — Click in viewport to place. Press Esc to exit.
          </span>
        ) : selectedGuid ? (
          <span>Selected element: {selectedGuid}. Spacebar to flip orientation, Delete to remove.</span>
        ) : (
          <span>Ready. Click to select, Shift+MMB to Orbit, MMB to Pan.</span>
        )}
      </div>

      {/* Right: Two-letter hotkey buffer & Coordinate Status */}
      <div className="flex items-center space-x-3">
        {keyBuffer && (
          <div className="bg-[#0284c7] text-white px-1.5 py-0.5 rounded font-mono font-bold text-[10px]">
            [{keyBuffer}_]
          </div>
        )}
        <div className="font-mono text-[10px] text-[#71717a]">EPSG:2285 NAD83</div>
      </div>
    </div>
  );
};
