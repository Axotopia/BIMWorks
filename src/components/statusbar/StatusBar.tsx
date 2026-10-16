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
import { toolCaption, toolPrompt } from '../../interaction/toolCaptions';

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
    interactionSession,
    keyBuffer,
    setViewRangeModalOpen,
    statusMessage,
    isLoadingFile,
    displayUnit,
    setDisplayUnit,
    georeference,
  } = useBimStore();

  const isTempActive = hiddenGuids.length > 0 || isolatedGuids.length > 0;

  return (
    <div className="flex items-center justify-between px-3 py-1 bg-[#f0f0f0] border-t border-[#dcdcdc] select-none text-[11px] text-[#333333] z-20 font-sans">
      {/* Left: View Control Bar (Revit View Control Strip) */}
      <div className="flex items-center space-x-2">
        {/* Unit System Selector (Spec §11: Decimal-Feet Internals) */}
        <select
          value={displayUnit}
          onChange={(e) => setDisplayUnit(e.target.value as any)}
          className="bg-[#ffffff] border border-[#cbd5e1] text-[#0284c7] font-medium rounded px-1.5 py-0.5 text-[10px] cursor-pointer focus:outline-none focus:border-[#007acc]"
          title="Display Units (Engine Representation: Decimal Feet)"
        >
          <option value="imperial_fractional">Fract (Ft-In)</option>
          <option value="imperial_decimal">Dec Feet</option>
          <option value="metric_mm">Metric (mm)</option>
          <option value="metric_m">Metric (m)</option>
        </select>

        {/* Scale Selector */}
        <select
          value={activeScale}
          onChange={(e) => setScale(e.target.value)}
          className="bg-[#ffffff] border border-[#cbd5e1] text-[#1e293b] font-medium rounded px-1.5 py-0.5 text-[10px] cursor-pointer focus:outline-none focus:border-[#007acc]"
        >
          <option value='1/8" = 1&apos;-0"'>1/8" = 1'-0"</option>
          <option value='1/4" = 1&apos;-0"'>1/4" = 1'-0"</option>
          <option value='1/2" = 1&apos;-0"'>1/2" = 1'-0"</option>
          <option value="1:100">1:100 (Metric)</option>
          <option value="1:50">1:50 (Metric)</option>
        </select>

        {/* Detail Level */}
        <div className="flex items-center space-x-0.5 bg-[#ffffff] border border-[#cbd5e1] rounded p-0.5">
          {(['coarse', 'medium', 'fine'] as const).map((lvl) => (
            <button
              key={lvl}
              onClick={() => setDetailLevel(lvl)}
              className={`px-1.5 py-0.5 rounded capitalize text-[10px] ${
                activeDetailLevel === lvl ? 'bg-[#cce8ff] text-[#094771] font-bold' : 'text-[#64748b] hover:text-[#0f172a]'
              }`}
            >
              {lvl}
            </button>
          ))}
        </div>

        {/* Visual Style */}
        <div className="flex items-center space-x-0.5 bg-[#ffffff] border border-[#cbd5e1] rounded p-0.5">
          <button
            onClick={() => setVisualStyle('hidden_line')}
            className={`px-1.5 py-0.5 rounded text-[10px] ${
              activeVisualStyle === 'hidden_line' ? 'bg-[#cce8ff] text-[#094771] font-bold' : 'text-[#64748b] hover:text-[#0f172a]'
            }`}
            title="Hidden Line"
          >
            HL
          </button>
          <button
            onClick={() => setVisualStyle('consistent_colors')}
            className={`px-1.5 py-0.5 rounded text-[10px] ${
              activeVisualStyle === 'consistent_colors' ? 'bg-[#cce8ff] text-[#094771] font-bold' : 'text-[#64748b] hover:text-[#0f172a]'
            }`}
            title="Consistent Colors (Revit Default)"
          >
            CC
          </button>
          <button
            onClick={() => setVisualStyle('wireframe')}
            className={`px-1.5 py-0.5 rounded text-[10px] ${
              activeVisualStyle === 'wireframe' ? 'bg-[#cce8ff] text-[#094771] font-bold' : 'text-[#64748b] hover:text-[#0f172a]'
            }`}
            title="Wireframe"
          >
            WF
          </button>
        </div>

        {/* View Range Modal Button */}
        <button
          onClick={() => setViewRangeModalOpen(true)}
          className="p-1 hover:bg-[#e2e8f0] rounded text-[#475569] hover:text-[#0284c7] flex items-center space-x-1"
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
                ? 'bg-[#0284c7] text-white border-[#0284c7] font-bold'
                : 'border-transparent hover:bg-[#e2e8f0] text-[#475569]'
            }`}
            title="Temporary Hide/Isolate (HH, HI, HR)"
          >
            <Glasses size={14} />
            {isTempActive && <span className="text-[10px]">Active</span>}
          </button>
        </div>
      </div>

      {/* Middle: Active Command Guidance & Status Message */}
      <div className="text-[#a1a1aa] font-medium hidden lg:flex items-center space-x-2">
        {isLoadingFile ? (
          <span className="text-[#38bdf8] font-semibold flex items-center space-x-1.5 animate-pulse">
            <span className="w-1.5 h-1.5 rounded-full bg-[#38bdf8]" />
            <span>{statusMessage}</span>
          </span>
        ) : activeTool !== 'select' ? (
          <span className="text-[#38bdf8] font-semibold">
            {/* UI-P0-14: say the command's name, not its tool code, and never claim a
                placement is in progress for a tool no viewport implements. */}
            {toolCaption(activeTool)} — {toolPrompt(activeTool, interactionSession?.phase, interactionSession?.picks.length)}
          </span>
        ) : selectedGuid ? (
          // UI-P0-18: this used to promise "Spacebar to flip orientation", which was
          // never bound to anything. Delete is real; the hint only mentions what works.
          <span>Selected element: {selectedGuid}. Delete removes it; Escape clears the selection.</span>
        ) : (
          <span className="text-[#94a3b8]">{statusMessage}</span>
        )}
      </div>

      {/* Right: Two-letter hotkey buffer & Coordinate Status */}
      <div className="flex items-center space-x-3">
        {keyBuffer && (
          <div className="bg-[#0284c7] text-white px-1.5 py-0.5 rounded font-mono font-bold text-[10px]">
            [{keyBuffer}_]
          </div>
        )}
        {/* UI-P0-7: this was a hardcoded "EPSG:2285 NAD83" label regardless of the
            project, while the real value lives in the store and can be unset. */}
        <div className="font-mono text-[10px] text-[#71717a]" title="Projected coordinate reference system">
          {georeference.projected_crs
            ? georeference.projected_crs.split(' - ')[0]
            : <span className="text-[#5a5a5a]">No CRS</span>}
        </div>
      </div>
    </div>
  );
};
