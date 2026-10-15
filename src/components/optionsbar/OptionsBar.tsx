import React, { useState, useEffect } from 'react';
import { useBimStore } from '../../store/useBimStore';
import { formatLength, tryParseLength } from '../../utils/units';
import {
  RotateCw,
  Sparkles,
  Trash2,
  SlidersHorizontal,
  Grid,
  Check,
  ChevronDown,
} from 'lucide-react';

export const OptionsBar: React.FC = () => {
  const {
    activeTool,
    chainTools,
    setChainTools,
    wallHeight,
    setWallHeight,
    wallLocationLine,
    setWallLocationLine,
    wallOffset,
    setWallOffset,
    wallLevelId,
    setWallLevelId,
    levels,
    displayUnit,
    selectedGuid,
    selectedGuids,
    elements,
    meshes,
    types,
    createSimilar,
    flipElementOrientation,
    handleDeleteKey,
    setEditTypeModalOpen,
    snapsEnabled,
    toggleSnaps,
  } = useBimStore();

  const [heightInput, setHeightInput] = useState<string>('');
  const [offsetInput, setOffsetInput] = useState<string>('');
  const [sillInput, setSillInput] = useState<string>('3\' 0"');

  // Keep height and offset input text in sync with store
  useEffect(() => {
    setHeightInput(formatLength(wallHeight, displayUnit));
  }, [wallHeight, displayUnit]);

  useEffect(() => {
    setOffsetInput(formatLength(wallOffset, displayUnit));
  }, [wallOffset, displayUnit]);

  const commitHeight = () => {
    const parsed = tryParseLength(heightInput);
    if (parsed !== null && parsed > 0.1) {
      setWallHeight(parsed);
    } else {
      setHeightInput(formatLength(wallHeight, displayUnit));
    }
  };

  const commitOffset = () => {
    const parsed = tryParseLength(offsetInput);
    if (parsed !== null) {
      setWallOffset(parsed);
    } else {
      setOffsetInput(formatLength(wallOffset, displayUnit));
    }
  };

  // Inspect selected element
  const hasSelection = selectedGuids.length > 0 || Boolean(selectedGuid);
  const primaryGuid = selectedGuids.length > 0 ? selectedGuids[selectedGuids.length - 1] : selectedGuid;
  const primaryElem = primaryGuid ? elements[primaryGuid] : null;
  const primaryMesh = primaryGuid ? meshes.find((m) => m.guid === primaryGuid) : null;
  const ifcClass = primaryElem?.ifc_class || primaryMesh?.ifc_class || '';
  const isWall = ifcClass === 'IfcWall' || ifcClass === 'IfcWallStandardCase';
  const isDoor = ifcClass === 'IfcDoor';
  const isWindow = ifcClass === 'IfcWindow';
  const canFlip = isWall || isDoor || isWindow;

  let categoryLabel = 'Element';
  if (isWall) categoryLabel = 'Walls';
  else if (isDoor) categoryLabel = 'Doors';
  else if (isWindow) categoryLabel = 'Windows';
  else if (ifcClass === 'IfcSlab') categoryLabel = 'Floors';
  else if (ifcClass === 'IfcRoof') categoryLabel = 'Roofs';
  else if (selectedGuids.length > 1) categoryLabel = `Multi-Select (${selectedGuids.length})`;

  return (
    <div className="flex items-center px-3 py-1 bg-[#f8fafc] border-b border-[#cbd5e1] text-xs text-[#334155] min-h-[30px] space-x-3 overflow-x-auto select-none shadow-xs">
      {/* 1. WALL TOOL ACTIVE OPTIONS */}
      {activeTool === 'WA' ? (
        <div className="flex items-center space-x-3 flex-wrap">
          <span className="font-bold text-[#0284c7] tracking-tight">Wall:</span>

          {/* Level / Height Mode */}
          <div className="flex items-center space-x-1">
            <span className="text-[#64748b] text-[11px]">Level:</span>
            <select
              value={wallLevelId || 'unconnected'}
              onChange={(e) => setWallLevelId(e.target.value === 'unconnected' ? null : e.target.value)}
              className="bg-[#ffffff] border border-[#cbd5e1] rounded px-1.5 py-0.5 text-[11px] font-medium text-[#1e293b] focus:border-[#0284c7] outline-none"
            >
              <option value="unconnected">Unconnected</option>
              {levels.map((lvl) => (
                <option key={lvl.id} value={lvl.id}>
                  {lvl.name} ({formatLength(lvl.elevation, displayUnit)})
                </option>
              ))}
            </select>
          </div>

          {/* Unconnected Height Input */}
          <div className="flex items-center space-x-1">
            <span className="text-[#64748b] text-[11px]">Height:</span>
            <input
              type="text"
              value={heightInput}
              onChange={(e) => setHeightInput(e.target.value)}
              onBlur={commitHeight}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitHeight();
              }}
              className="w-18 bg-[#ffffff] border border-[#cbd5e1] rounded px-1.5 py-0.5 text-[11px] font-mono text-[#1e293b] focus:border-[#0284c7] outline-none text-center"
              title="Unconnected Wall Height"
            />
          </div>

          {/* Location Line Dropdown */}
          <div className="flex items-center space-x-1">
            <span className="text-[#64748b] text-[11px]">Location Line:</span>
            <select
              value={wallLocationLine}
              onChange={(e) => setWallLocationLine(e.target.value as any)}
              className="bg-[#ffffff] border border-[#cbd5e1] rounded px-1.5 py-0.5 text-[11px] font-medium text-[#1e293b] focus:border-[#0284c7] outline-none"
            >
              <option value="centerline">Wall Centerline</option>
              <option value="core_centerline">Core Centerline</option>
              <option value="exterior">Finish Face: Exterior</option>
              <option value="interior">Finish Face: Interior</option>
            </select>
          </div>

          {/* Chain Checkbox */}
          <label className="flex items-center space-x-1 cursor-pointer">
            <input
              type="checkbox"
              checked={chainTools}
              onChange={(e) => setChainTools(e.target.checked)}
              className="rounded border-[#cbd5e1] text-[#007acc] focus:ring-0"
            />
            <span className="text-[11px] font-medium text-[#1e293b]">Chain</span>
          </label>

          {/* Offset Input */}
          <div className="flex items-center space-x-1">
            <span className="text-[#64748b] text-[11px]">Offset:</span>
            <input
              type="text"
              value={offsetInput}
              onChange={(e) => setOffsetInput(e.target.value)}
              onBlur={commitOffset}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitOffset();
              }}
              className="w-14 bg-[#ffffff] border border-[#cbd5e1] rounded px-1.5 py-0.5 text-[11px] font-mono text-[#1e293b] focus:border-[#0284c7] outline-none text-center"
              title="Baseline Offset"
            />
          </div>

          {/* Join Status */}
          <div className="flex items-center space-x-1 text-[11px]">
            <span className="text-[#64748b]">Join Status:</span>
            <span className="bg-[#f1f5f9] border border-[#cbd5e1] px-1.5 py-0.5 rounded font-medium text-[#475569]">
              Allow
            </span>
          </div>
        </div>
      ) : activeTool === 'DR' || activeTool === 'WN' ? (
        /* 2. DOOR / WINDOW TOOL ACTIVE OPTIONS */
        <div className="flex items-center space-x-3 flex-wrap">
          <span className="font-bold text-[#0284c7]">
            {activeTool === 'DR' ? 'Door Placement:' : 'Window Placement:'}
          </span>

          <label className="flex items-center space-x-1 cursor-pointer">
            <input
              type="checkbox"
              checked={chainTools}
              onChange={(e) => setChainTools(e.target.checked)}
              className="rounded border-[#cbd5e1] text-[#007acc] focus:ring-0"
            />
            <span className="text-[11px] font-medium text-[#1e293b]">Chain Placement</span>
          </label>

          <label className="flex items-center space-x-1 cursor-pointer">
            <input
              type="checkbox"
              defaultChecked
              className="rounded border-[#cbd5e1] text-[#007acc] focus:ring-0"
            />
            <span className="text-[11px] font-medium text-[#1e293b]">Tag on Placement</span>
          </label>

          {activeTool === 'WN' && (
            <div className="flex items-center space-x-1">
              <span className="text-[#64748b] text-[11px]">Sill Height:</span>
              <input
                type="text"
                value={sillInput}
                onChange={(e) => setSillInput(e.target.value)}
                className="w-16 bg-[#ffffff] border border-[#cbd5e1] rounded px-1.5 py-0.5 text-[11px] font-mono text-[#1e293b] focus:border-[#0284c7] outline-none text-center"
                title="Window Sill Height"
              />
            </div>
          )}

          <span className="text-[11px] text-[#64748b]">
            Hover over an existing wall to host and click to place.
          </span>
        </div>
      ) : activeTool === 'AL' ? (
        /* 3. ALIGN TOOL ACTIVE OPTIONS */
        <div className="flex items-center space-x-3 flex-wrap">
          <span className="font-bold text-[#0284c7]">Align:</span>
          <label className="flex items-center space-x-1 cursor-pointer">
            <input type="checkbox" className="rounded border-[#cbd5e1] text-[#007acc]" />
            <span className="text-[11px] font-medium text-[#1e293b]">Multiple Alignment</span>
          </label>
          <label className="flex items-center space-x-1 cursor-pointer">
            <input type="checkbox" defaultChecked className="rounded border-[#cbd5e1] text-[#007acc]" />
            <span className="text-[11px] font-medium text-[#1e293b]">Lock</span>
          </label>
          <div className="flex items-center space-x-1">
            <span className="text-[#64748b] text-[11px]">Prefer:</span>
            <select className="bg-[#ffffff] border border-[#cbd5e1] rounded px-1.5 py-0.5 text-[11px] font-medium text-[#1e293b] outline-none">
              <option>Wall centerlines</option>
              <option>Wall faces</option>
            </select>
          </div>
        </div>
      ) : activeTool === 'TR' ? (
        /* 4. TRIM TOOL ACTIVE OPTIONS */
        <div className="flex items-center space-x-3 flex-wrap">
          <span className="font-bold text-[#0284c7]">Trim / Extend:</span>
          <div className="flex items-center bg-[#ffffff] border border-[#cbd5e1] rounded p-0.5 text-[11px] font-medium">
            <span className="px-2 py-0.5 bg-[#cce8ff] text-[#0369a1] rounded font-bold">
              Corner (TR)
            </span>
            <span className="px-2 py-0.5 text-[#64748b]">Single</span>
            <span className="px-2 py-0.5 text-[#64748b]">Multiple</span>
          </div>
          <span className="text-[11px] text-[#64748b]">
            Click first element, then click second element to trim to corner.
          </span>
        </div>
      ) : hasSelection ? (
        /* 5. SELECTION CONTEXTUAL OPTIONS */
        <div className="flex items-center space-x-3 flex-wrap w-full">
          <div className="flex items-center space-x-1.5 px-2 py-0.5 bg-[#008272] text-white rounded text-[11px] font-bold shadow-xs">
            <span>Modify | {categoryLabel}</span>
          </div>

          <span className="font-medium text-[11px] text-[#1e293b] truncate max-w-[260px]">
            {primaryElem?.name || primaryMesh?.name || 'Selected Element'}
          </span>

          <div className="h-3 w-[1px] bg-[#cbd5e1]" />

          {/* Contextual actions */}
          {canFlip && primaryGuid && (
            <button
              onClick={() => flipElementOrientation(primaryGuid)}
              className="flex items-center space-x-1 px-2 py-0.5 bg-[#ffffff] hover:bg-[#e0f2fe] border border-[#cbd5e1] hover:border-[#bae6fd] rounded text-[11px] text-[#0369a1] font-medium transition-colors"
              title="Flip Element Facing or Direction (Space)"
            >
              <RotateCw size={11} />
              <span>Flip ({isDoor ? 'Swing' : 'Orientation'})</span>
            </button>
          )}

          <button
            onClick={() => createSimilar()}
            className="flex items-center space-x-1 px-2 py-0.5 bg-[#ffffff] hover:bg-[#e0f2fe] border border-[#cbd5e1] hover:border-[#bae6fd] rounded text-[11px] text-[#0369a1] font-medium transition-colors"
            title="Create Similar Element (CS)"
          >
            <Sparkles size={11} className="text-[#0284c7]" />
            <span>Create Similar (CS)</span>
          </button>

          <button
            onClick={() => setEditTypeModalOpen(true)}
            className="flex items-center space-x-1 px-2 py-0.5 bg-[#ffffff] hover:bg-[#f1f5f9] border border-[#cbd5e1] rounded text-[11px] text-[#475569] font-medium transition-colors"
            title="Edit Type Properties"
          >
            <SlidersHorizontal size={11} />
            <span>Edit Type</span>
          </button>

          <button
            onClick={() => handleDeleteKey()}
            className="flex items-center space-x-1 px-2 py-0.5 bg-[#ffffff] hover:bg-[#fee2e2] border border-[#fca5a5] rounded text-[11px] text-[#dc2626] font-medium transition-colors ml-auto"
            title="Delete Selected Elements (Delete)"
          >
            <Trash2 size={11} />
            <span>Delete</span>
          </button>
        </div>
      ) : (
        /* 6. IDLE / READY STATE */
        <div className="flex items-center justify-between w-full text-[11px] text-[#64748b]">
          <div className="flex items-center space-x-2">
            <span className="font-semibold text-[#1e293b]">Ready</span>
            <span>•</span>
            <span className="hidden sm:inline">Shortcuts: WA Wall, DR Door, WN Window, TR Trim, AL Align, CS Similar, ZE Fit, WT Tile</span>
          </div>

          <div className="flex items-center space-x-2">
            <button
              onClick={() => toggleSnaps()}
              className={`flex items-center space-x-1 px-2 py-0.5 rounded text-[10px] font-medium border transition-colors ${
                snapsEnabled
                  ? 'bg-[#ecfdf5] border-[#a7f3d0] text-[#059669]'
                  : 'bg-[#fef2f2] border-[#fecaca] text-[#dc2626]'
              }`}
              title="Toggle Object Snaps (F3)"
            >
              <Grid size={10} />
              <span>Snaps: {snapsEnabled ? 'ON' : 'OFF'} (F3)</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
