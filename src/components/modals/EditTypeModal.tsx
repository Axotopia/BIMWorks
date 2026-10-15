import React, { useState, useEffect, useMemo } from 'react';
import { Settings, X, Copy, Plus, Trash2, Eye, EyeOff, Layers, Check } from 'lucide-react';
import { useBimStore } from '../../store/useBimStore';
import { formatLength } from '../../utils/units';
import { BimType, BimTypeLayer } from '../../types/bim';

export const EditTypeModal: React.FC = () => {
  const {
    isEditTypeModalOpen,
    setEditTypeModalOpen,
    selectedGuid,
    elements,
    meshes,
    types,
    updateType,
    duplicateType,
    displayUnit,
  } = useBimStore();

  const selectedMesh = meshes.find((m) => m.guid === selectedGuid);
  const currentElement = selectedGuid ? elements[selectedGuid] : null;

  // Determine initial type to edit
  const initialTypeId = useMemo(() => {
    if (currentElement?.type_id && types.some((t) => t.id === currentElement.type_id)) {
      return currentElement.type_id;
    }
    if (selectedMesh) {
      const isWall = selectedMesh.ifc_class.includes('Wall');
      const isDoor = selectedMesh.ifc_class.includes('Door');
      const isWin = selectedMesh.ifc_class.includes('Window');
      const match = types.find((t) => {
        if (isWall) return t.ifc_class.includes('Wall');
        if (isDoor) return t.ifc_class.includes('Door');
        if (isWin) return t.ifc_class.includes('Window');
        return false;
      });
      if (match) return match.id;
    }
    return types[0]?.id || '';
  }, [currentElement, selectedMesh, types]);

  const [activeTypeId, setActiveTypeId] = useState<string>(initialTypeId);

  // Sync activeTypeId when modal opens
  useEffect(() => {
    if (isEditTypeModalOpen && initialTypeId) {
      setActiveTypeId(initialTypeId);
    }
  }, [isEditTypeModalOpen, initialTypeId]);

  const activeType = useMemo(() => {
    return types.find((t) => t.id === activeTypeId) || types[0] || null;
  }, [types, activeTypeId]);

  // Form states
  const [thickness, setThickness] = useState<number>(0.8333);
  const [width, setWidth] = useState<number>(3.0);
  const [height, setHeight] = useState<number>(10.0);
  const [sillHeight, setSillHeight] = useState<number>(3.0);
  const [fireRating, setFireRating] = useState<string>('2 HR');
  const [func, setFunc] = useState<string>('Exterior');
  const [cost, setCost] = useState<string>('125.00');
  const [description, setDescription] = useState<string>('');
  const [layers, setLayers] = useState<BimTypeLayer[]>([]);
  const [showPreview, setShowPreview] = useState<boolean>(true);

  // Duplicate prompt state
  const [isDuplicating, setIsDuplicating] = useState<boolean>(false);
  const [duplicateName, setDuplicateName] = useState<string>('');

  // Status feedback
  const [appliedFeedback, setAppliedFeedback] = useState<string | null>(null);

  // Sync form state when activeType changes
  useEffect(() => {
    if (!activeType) return;
    const p = activeType.parameters || {};
    setThickness(p.thickness !== undefined ? Number(p.thickness) : 0.8333);
    setWidth(p.width !== undefined ? Number(p.width) : 3.0);
    setHeight(p.height !== undefined ? Number(p.height) : 10.0);
    setSillHeight(p.sill_height !== undefined ? Number(p.sill_height) : 3.0);
    setFireRating(p.fire_rating || '2 HR');
    setFunc(p.function || 'Exterior');
    setCost(p.cost || '120.00');
    setDescription(p.description || activeType.name);
    setLayers(
      p.layers && Array.isArray(p.layers)
        ? p.layers
        : [
            { function: 'Core [1]', material: 'Concrete Masonry Units', thickness: Number(p.thickness || 0.8333) },
          ]
    );
    setAppliedFeedback(null);
  }, [activeType]);

  if (!isEditTypeModalOpen) return null;

  const isWallType = activeType?.ifc_class?.includes('Wall') || activeType?.id?.startsWith('wall');
  const isDoorType = activeType?.ifc_class?.includes('Door') || activeType?.id?.startsWith('door');
  const isWindowType = activeType?.ifc_class?.includes('Window') || activeType?.id?.startsWith('window');

  // Calculate total thickness from layers if applicable
  const totalLayerThickness = layers.reduce((acc, l) => acc + (Number(l.thickness) || 0), 0);
  const effectiveThickness = layers.length > 0 ? totalLayerThickness : thickness;

  const handleApply = async () => {
    if (!activeType) return;
    const updatedParams: Record<string, any> = {
      ...activeType.parameters,
      thickness: effectiveThickness,
      fire_rating: fireRating,
      function: func,
      cost,
      description,
      layers,
    };
    if (isDoorType || isWindowType) {
      updatedParams.width = width;
      updatedParams.height = height;
    }
    if (isWindowType) {
      updatedParams.sill_height = sillHeight;
    }

    await updateType(activeType.id, updatedParams);
    setAppliedFeedback('Type parameters updated & propagated to model.');
    setTimeout(() => setAppliedFeedback(null), 3000);
  };

  const handleOk = async () => {
    await handleApply();
    setEditTypeModalOpen(false);
  };

  const handleStartDuplicate = () => {
    if (!activeType) return;
    setDuplicateName(`${activeType.name} (Copy)`);
    setIsDuplicating(true);
  };

  const handleConfirmDuplicate = async () => {
    if (!activeType || !duplicateName.trim()) return;
    const newTypeId = `${activeType.id}-${Date.now().toString(36)}`;
    await duplicateType(activeType.id, newTypeId, duplicateName.trim());
    setIsDuplicating(false);
    setActiveTypeId(newTypeId);
  };

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-xs flex items-center justify-center z-50 p-4">
      <div className="bg-[#f0f0f0] border border-[#a0a0a0] rounded shadow-2xl w-full max-w-4xl text-[#222222] text-xs flex flex-col max-h-[90vh] overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-3 py-2 bg-[#e0e0e0] border-b border-[#cccccc] select-none">
          <div className="flex items-center space-x-2 font-semibold text-[#1e293b]">
            <Settings size={14} className="text-[#007acc]" />
            <span className="text-[13px]">Type Properties</span>
          </div>
          <button
            onClick={() => setEditTypeModalOpen(false)}
            className="p-1 hover:bg-[#d0d0d0] rounded text-[#666666] hover:text-black"
          >
            <X size={15} />
          </button>
        </div>

        {/* Top Control Bar: Family, Type Selector, Duplicate */}
        <div className="p-3 bg-[#f8f8f8] border-b border-[#d8d8d8] flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center space-x-3">
            <div>
              <span className="text-[#666666] text-[11px] font-medium mr-1.5">Family:</span>
              <span className="font-semibold text-[#1e293b] text-[12px]">
                {activeType?.family_name || (isWallType ? 'System Family: Basic Wall' : isDoorType ? 'Door' : isWindowType ? 'Window' : 'System Family')}
              </span>
            </div>
            <div className="flex items-center space-x-1.5">
              <span className="text-[#666666] text-[11px] font-medium">Type:</span>
              <select
                value={activeTypeId}
                onChange={(e) => setActiveTypeId(e.target.value)}
                className="px-2 py-1 bg-white border border-[#b0b0b0] rounded text-[11px] text-[#222222] font-semibold min-w-[220px]"
              >
                {types.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="flex items-center space-x-2">
            <button
              onClick={handleStartDuplicate}
              className="flex items-center space-x-1 px-2.5 py-1 bg-[#ffffff] hover:bg-[#e9e9e9] border border-[#b0b0b0] rounded text-[11px] font-medium text-[#222222] shadow-xs"
            >
              <Copy size={12} className="text-[#007acc]" />
              <span>Duplicate...</span>
            </button>
            <button
              onClick={() => setShowPreview(!showPreview)}
              className="flex items-center space-x-1 px-2.5 py-1 bg-[#ffffff] hover:bg-[#e9e9e9] border border-[#b0b0b0] rounded text-[11px] font-medium text-[#222222] shadow-xs"
            >
              {showPreview ? <EyeOff size={12} /> : <Eye size={12} />}
              <span>{showPreview ? 'Hide Preview' : 'Preview'}</span>
            </button>
          </div>
        </div>

        {/* Duplicate Prompt Banner */}
        {isDuplicating && (
          <div className="px-3 py-2 bg-[#e0f2fe] border-b border-[#7dd3fc] flex items-center justify-between">
            <div className="flex items-center space-x-2 flex-1">
              <span className="font-semibold text-[#0369a1] text-[11px]">New Type Name:</span>
              <input
                type="text"
                value={duplicateName}
                onChange={(e) => setDuplicateName(e.target.value)}
                className="px-2 py-0.5 bg-white border border-[#0284c7] rounded text-[11px] flex-1 max-w-md font-medium"
                autoFocus
              />
            </div>
            <div className="flex items-center space-x-1.5 ml-2">
              <button
                onClick={handleConfirmDuplicate}
                className="px-2.5 py-0.5 bg-[#0284c7] hover:bg-[#0369a1] text-white rounded font-medium text-[11px]"
              >
                OK
              </button>
              <button
                onClick={() => setIsDuplicating(false)}
                className="px-2 py-0.5 bg-white hover:bg-gray-100 border border-[#b0b0b0] rounded text-[11px]"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Main Body: Preview + Parameter Table */}
        <div className="flex-1 flex overflow-hidden">
          {/* Left Preview Pane */}
          {showPreview && (
            <div className="w-56 bg-[#252526] border-r border-[#dcdcdc] p-3 flex flex-col text-white">
              <div className="flex items-center justify-between text-[11px] font-bold text-[#94a3b8] mb-2 uppercase tracking-wide">
                <span>Section Preview</span>
                <span className="font-mono text-[10px] text-[#38bdf8]">{formatLength(effectiveThickness, displayUnit)}</span>
              </div>
              <div className="flex-1 bg-[#1a1a1a] border border-[#3f3f46] rounded p-2 flex flex-col justify-center items-center relative overflow-hidden">
                {/* SVG Compound Structure Preview */}
                <svg className="w-full h-full max-h-64" viewBox="0 0 160 240">
                  <defs>
                    <pattern id="cmuHatch" width="8" height="8" patternUnits="userSpaceOnUse">
                      <path d="M 0 0 L 8 8 M 8 0 L 0 8" stroke="#475569" strokeWidth="0.5" />
                    </pattern>
                    <pattern id="insulHatch" width="6" height="12" patternUnits="userSpaceOnUse">
                      <path d="M 0 6 Q 3 0 6 6 T 12 6" fill="none" stroke="#f59e0b" strokeWidth="0.75" />
                    </pattern>
                  </defs>

                  {/* Draw layer slabs */}
                  {(() => {
                    let curX = 25;
                    const totalW = 110;
                    return layers.map((layer, idx) => {
                      const layerW = totalLayerThickness > 0 ? (layer.thickness / totalLayerThickness) * totalW : totalW / layers.length;
                      const x = curX;
                      curX += layerW;

                      const isCore = layer.function.toLowerCase().includes('core') || layer.function.toLowerCase().includes('structure');
                      const fill = isCore ? 'url(#cmuHatch)' : idx % 2 === 0 ? '#334155' : '#475569';

                      return (
                        <g key={idx}>
                          <rect
                            x={x}
                            y={20}
                            width={Math.max(layerW, 3)}
                            height={200}
                            fill={fill}
                            stroke="#64748b"
                            strokeWidth="1"
                          />
                          {/* Core boundary marks */}
                          {isCore && (
                            <line x1={x} y1={15} x2={x} y2={225} stroke="#38bdf8" strokeWidth="1" strokeDasharray="3,3" />
                          )}
                        </g>
                      );
                    });
                  })()}

                  {/* Dimension Line across total width */}
                  <line x1="25" y1="10" x2="135" y2="10" stroke="#38bdf8" strokeWidth="1" />
                  <line x1="25" y1="6" x2="25" y2="14" stroke="#38bdf8" strokeWidth="1" />
                  <line x1="135" y1="6" x2="135" y2="14" stroke="#38bdf8" strokeWidth="1" />
                  <text x="80" y="8" fill="#38bdf8" fontSize="8" textAnchor="middle" fontFamily="monospace">
                    {formatLength(effectiveThickness, displayUnit)}
                  </text>
                </svg>
              </div>
              <div className="mt-2 text-[10px] text-[#94a3b8] text-center font-mono">
                {layers.length} compound layer{layers.length !== 1 ? 's' : ''}
              </div>
            </div>
          )}

          {/* Right Parameter Table */}
          <div className="flex-1 overflow-y-auto p-3 space-y-4 bg-white">
            {/* Parameters Table */}
            <div className="border border-[#cccccc] rounded overflow-hidden">
              <table className="w-full text-[11px] border-collapse">
                <thead>
                  <tr className="bg-[#e9e9e9] border-b border-[#cccccc] text-left text-[#555555]">
                    <th className="py-1 px-2.5 font-bold w-1/2">Parameter</th>
                    <th className="py-1 px-2.5 font-bold">Value</th>
                  </tr>
                </thead>
                <tbody>
                  {/* Category: Construction */}
                  <tr className="bg-[#f4f4f4] border-b border-[#e0e0e0] font-bold text-[#1e293b]">
                    <td colSpan={2} className="py-1 px-2.5 text-[10px] uppercase tracking-wider text-[#64748b]">
                      Construction
                    </td>
                  </tr>

                  {/* Function */}
                  <tr className="border-b border-[#eeeeee]">
                    <td className="py-1 px-2.5 text-[#333333]">Function</td>
                    <td className="py-1 px-2.5">
                      <select
                        value={func}
                        onChange={(e) => setFunc(e.target.value)}
                        className="w-full px-1.5 py-0.5 border border-[#cccccc] rounded bg-white text-[11px]"
                      >
                        <option value="Exterior">Exterior</option>
                        <option value="Interior">Interior</option>
                        <option value="Retaining">Retaining</option>
                        <option value="Soffit">Soffit</option>
                      </select>
                    </td>
                  </tr>

                  {/* Category: Dimensions */}
                  <tr className="bg-[#f4f4f4] border-b border-[#e0e0e0] font-bold text-[#1e293b]">
                    <td colSpan={2} className="py-1 px-2.5 text-[10px] uppercase tracking-wider text-[#64748b]">
                      Dimensions
                    </td>
                  </tr>

                  {/* Thickness */}
                  <tr className="border-b border-[#eeeeee]">
                    <td className="py-1 px-2.5 text-[#333333]">
                      Structure Thickness ({formatLength(effectiveThickness, displayUnit)})
                    </td>
                    <td className="py-1 px-2.5">
                      <input
                        type="number"
                        step="0.01"
                        value={thickness}
                        onChange={(e) => {
                          const val = parseFloat(e.target.value) || 0.1;
                          setThickness(val);
                          if (layers.length === 1) {
                            setLayers([{ ...layers[0], thickness: val }]);
                          }
                        }}
                        className="w-full px-1.5 py-0.5 border border-[#cccccc] rounded text-right font-mono"
                      />
                    </td>
                  </tr>

                  {/* Width (for Doors / Windows) */}
                  {(isDoorType || isWindowType) && (
                    <tr className="border-b border-[#eeeeee]">
                      <td className="py-1 px-2.5 text-[#333333]">Width ({formatLength(width, displayUnit)})</td>
                      <td className="py-1 px-2.5">
                        <input
                          type="number"
                          step="0.1"
                          value={width}
                          onChange={(e) => setWidth(parseFloat(e.target.value) || 1.0)}
                          className="w-full px-1.5 py-0.5 border border-[#cccccc] rounded text-right font-mono"
                        />
                      </td>
                    </tr>
                  )}

                  {/* Height (for Doors / Windows) */}
                  {(isDoorType || isWindowType) && (
                    <tr className="border-b border-[#eeeeee]">
                      <td className="py-1 px-2.5 text-[#333333]">Height ({formatLength(height, displayUnit)})</td>
                      <td className="py-1 px-2.5">
                        <input
                          type="number"
                          step="0.1"
                          value={height}
                          onChange={(e) => setHeight(parseFloat(e.target.value) || 1.0)}
                          className="w-full px-1.5 py-0.5 border border-[#cccccc] rounded text-right font-mono"
                        />
                      </td>
                    </tr>
                  )}

                  {/* Sill Height (for Windows) */}
                  {isWindowType && (
                    <tr className="border-b border-[#eeeeee]">
                      <td className="py-1 px-2.5 text-[#333333]">Default Sill Height ({formatLength(sillHeight, displayUnit)})</td>
                      <td className="py-1 px-2.5">
                        <input
                          type="number"
                          step="0.1"
                          value={sillHeight}
                          onChange={(e) => setSillHeight(parseFloat(e.target.value) || 0.0)}
                          className="w-full px-1.5 py-0.5 border border-[#cccccc] rounded text-right font-mono"
                        />
                      </td>
                    </tr>
                  )}

                  {/* Category: Identity Data */}
                  <tr className="bg-[#f4f4f4] border-b border-[#e0e0e0] font-bold text-[#1e293b]">
                    <td colSpan={2} className="py-1 px-2.5 text-[10px] uppercase tracking-wider text-[#64748b]">
                      Identity Data
                    </td>
                  </tr>

                  {/* Fire Rating */}
                  <tr className="border-b border-[#eeeeee]">
                    <td className="py-1 px-2.5 text-[#333333]">Fire Rating</td>
                    <td className="py-1 px-2.5">
                      <select
                        value={fireRating}
                        onChange={(e) => setFireRating(e.target.value)}
                        className="w-full px-1.5 py-0.5 border border-[#cccccc] rounded bg-white text-[11px]"
                      >
                        <option value="0 HR">0 HR</option>
                        <option value="1 HR">1 HR</option>
                        <option value="2 HR">2 HR</option>
                        <option value="3 HR">3 HR</option>
                        <option value="4 HR">4 HR</option>
                      </select>
                    </td>
                  </tr>

                  {/* Cost */}
                  <tr className="border-b border-[#eeeeee]">
                    <td className="py-1 px-2.5 text-[#333333]">Cost ($ / sq ft)</td>
                    <td className="py-1 px-2.5">
                      <input
                        type="text"
                        value={cost}
                        onChange={(e) => setCost(e.target.value)}
                        className="w-full px-1.5 py-0.5 border border-[#cccccc] rounded"
                      />
                    </td>
                  </tr>

                  {/* Description */}
                  <tr className="border-b border-[#eeeeee]">
                    <td className="py-1 px-2.5 text-[#333333]">Description</td>
                    <td className="py-1 px-2.5">
                      <input
                        type="text"
                        value={description}
                        onChange={(e) => setDescription(e.target.value)}
                        className="w-full px-1.5 py-0.5 border border-[#cccccc] rounded"
                      />
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            {/* Compound Structure Layers Table */}
            {isWallType && (
              <div className="border border-[#cccccc] rounded overflow-hidden">
                <div className="bg-[#e9e9e9] px-2.5 py-1.5 font-bold text-[#1e293b] flex items-center justify-between border-b border-[#cccccc]">
                  <div className="flex items-center space-x-1.5">
                    <Layers size={13} className="text-[#007acc]" />
                    <span>Compound Structure Layers</span>
                  </div>
                  <span className="text-[10px] text-[#64748b] font-mono">
                    Total: {formatLength(totalLayerThickness, displayUnit)}
                  </span>
                </div>
                <table className="w-full text-[11px] border-collapse">
                  <thead>
                    <tr className="bg-[#f8f8f8] border-b border-[#e5e5e5] text-left text-[#555555]">
                      <th className="py-1 px-2 w-8">#</th>
                      <th className="py-1 px-2">Function</th>
                      <th className="py-1 px-2">Material</th>
                      <th className="py-1 px-2 text-right">Thickness</th>
                    </tr>
                  </thead>
                  <tbody>
                    {layers.map((l, idx) => (
                      <tr key={idx} className="border-b border-[#f0f0f0] hover:bg-[#f9fafb]">
                        <td className="py-1 px-2 text-[#888888] font-mono">{idx + 1}</td>
                        <td className="py-1 px-2 font-medium text-[#1e293b]">{l.function}</td>
                        <td className="py-1 px-2 text-[#475569]">{l.material}</td>
                        <td className="py-1 px-2 text-right font-mono text-[#007acc]">
                          {formatLength(l.thickness, displayUnit)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-3 py-2 bg-[#e0e0e0] border-t border-[#cccccc]">
          <div className="flex items-center space-x-1.5 text-[#16a34a] text-[11px] font-medium">
            {appliedFeedback && (
              <>
                <Check size={14} />
                <span>{appliedFeedback}</span>
              </>
            )}
          </div>
          <div className="flex items-center space-x-2">
            <button
              onClick={handleOk}
              className="px-4 py-1 bg-[#007acc] hover:bg-[#0062a3] text-white font-medium rounded shadow-xs text-[11px]"
            >
              OK
            </button>
            <button
              onClick={() => setEditTypeModalOpen(false)}
              className="px-4 py-1 bg-[#ffffff] hover:bg-[#e9e9e9] border border-[#b0b0b0] text-[#222222] font-medium rounded shadow-xs text-[11px]"
            >
              Cancel
            </button>
            <button
              onClick={handleApply}
              className="px-4 py-1 bg-[#ffffff] hover:bg-[#e9e9e9] border border-[#b0b0b0] text-[#222222] font-medium rounded shadow-xs text-[11px]"
            >
              Apply
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
