import React, { useState } from 'react';
import { X, Eye, EyeOff, Lock, Unlock, Plus, Layers, Palette } from 'lucide-react';
import { useBimStore } from '../../store/useBimStore';
import { DraftingLayer } from '../../types/bim';

interface LayersManagerModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const PEN_WEIGHT_OPTIONS = [0.13, 0.18, 0.25, 0.35, 0.50, 0.70, 1.00];
const LINE_TYPE_OPTIONS: Array<DraftingLayer['lineType']> = ['solid', 'dashed', 'dotted', 'dashdot'];
const COLOR_PRESETS = ['#0f172a', '#2563eb', '#dc2626', '#16a34a', '#ca8a04', '#9333ea', '#475569'];

export const LayersManagerModal: React.FC<LayersManagerModalProps> = ({ isOpen, onClose }) => {
  const {
    draftingLayers,
    layerGroups,
    updateDraftingLayer,
    addDraftingLayer,
    deleteDraftingLayer,
    activeLayerId,
    setActiveLayerId,
  } = useBimStore();

  const [newLayerName, setNewLayerName] = useState('');
  const [newLayerColor, setNewLayerColor] = useState('#0f172a');
  const [newLayerWeight, setNewLayerWeight] = useState(0.25);
  const [newLayerType, setNewLayerType] = useState<DraftingLayer['lineType']>('solid');
  const [newLayerGroup, setNewLayerGroup] = useState('group-annotations');
  const [showAddForm, setShowAddForm] = useState(false);

  if (!isOpen) return null;

  const handleCreateLayer = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newLayerName.trim()) return;

    const newId = `layer-${Date.now()}`;
    addDraftingLayer({
      id: newId,
      name: newLayerName.trim().toUpperCase(),
      groupId: newLayerGroup,
      colour: newLayerColor,
      penWeight: newLayerWeight,
      lineType: newLayerType,
      visible: true,
      locked: false,
    });

    setNewLayerName('');
    setShowAddForm(false);
  };

  const toggleGroupVisibility = (groupId: string) => {
    const groupLayers = draftingLayers.filter((l) => l.groupId === groupId);
    const anyVisible = groupLayers.some((l) => l.visible);
    groupLayers.forEach((l) => updateDraftingLayer(l.id, { visible: !anyVisible }));
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4">
      <div className="relative w-full max-w-2xl bg-[#1e293b] border border-slate-700 rounded-xl shadow-2xl text-white flex flex-col max-h-[85vh] overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-700/80 bg-[#0f172a]/60">
          <div className="flex items-center space-x-2.5">
            <Layers className="text-[#38bdf8]" size={20} />
            <h2 className="text-base font-bold tracking-wide">Sheet Drafting Layers</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-md text-slate-400 hover:text-white hover:bg-slate-700/60 transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {/* Layer Groups & Table */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {layerGroups.map((group) => {
            const layersInGroup = draftingLayers.filter((l) => l.groupId === group.id);
            const allVisible = layersInGroup.every((l) => l.visible);

            return (
              <div key={group.id} className="border border-slate-700/60 rounded-lg overflow-hidden bg-slate-900/40">
                {/* Group Title Bar */}
                <div className="flex items-center justify-between px-4 py-2 bg-slate-800/80 border-b border-slate-700/60 text-xs font-semibold text-slate-300">
                  <div className="flex items-center space-x-2">
                    <span>{group.name}</span>
                    <span className="text-[10px] bg-slate-700 px-1.5 py-0.2 rounded text-slate-400">
                      {layersInGroup.length}
                    </span>
                  </div>
                  <button
                    onClick={() => toggleGroupVisibility(group.id)}
                    className="flex items-center space-x-1 text-slate-400 hover:text-white transition-colors"
                    title={allVisible ? 'Hide Group' : 'Show Group'}
                  >
                    {allVisible ? <Eye size={14} /> : <EyeOff size={14} />}
                    <span className="text-[10px]">{allVisible ? 'All Visible' : 'Hidden'}</span>
                  </button>
                </div>

                {/* Layers in this group */}
                <div className="divide-y divide-slate-800">
                  {layersInGroup.map((layer) => (
                    <div
                      key={layer.id}
                      className={`flex items-center justify-between px-4 py-2.5 text-xs transition-colors ${
                        activeLayerId === layer.id ? 'bg-[#0284c7]/15' : 'hover:bg-slate-800/40'
                      }`}
                    >
                      {/* Left: Active radio + Name */}
                      <div className="flex items-center space-x-3">
                        <input
                          type="radio"
                          name="active-layer"
                          checked={activeLayerId === layer.id}
                          onChange={() => setActiveLayerId(layer.id)}
                          title="Set as Active Layer"
                          className="accent-[#0284c7] cursor-pointer"
                        />
                        <span className="font-mono font-medium text-slate-200">{layer.name}</span>
                      </div>

                      {/* Right: Controls (Visibility, Lock, Color, Weight, Line Type) */}
                      <div className="flex items-center space-x-3">
                        {/* Visibility Toggle */}
                        <button
                          onClick={() => updateDraftingLayer(layer.id, { visible: !layer.visible })}
                          className={`p-1 rounded transition-colors ${
                            layer.visible ? 'text-slate-300 hover:text-white' : 'text-slate-600 hover:text-slate-400'
                          }`}
                          title={layer.visible ? 'Visible (click to hide)' : 'Hidden (click to show)'}
                        >
                          {layer.visible ? <Eye size={15} /> : <EyeOff size={15} />}
                        </button>

                        {/* Lock Toggle */}
                        <button
                          onClick={() => updateDraftingLayer(layer.id, { locked: !layer.locked })}
                          className={`p-1 rounded transition-colors ${
                            layer.locked ? 'text-amber-400 hover:text-amber-300' : 'text-slate-500 hover:text-slate-300'
                          }`}
                          title={layer.locked ? 'Locked' : 'Unlocked'}
                        >
                          {layer.locked ? <Lock size={15} /> : <Unlock size={15} />}
                        </button>

                        {/* Color Picker Swatch */}
                        <div className="flex items-center space-x-1">
                          <input
                            type="color"
                            value={layer.colour}
                            onChange={(e) => updateDraftingLayer(layer.id, { colour: e.target.value })}
                            className="w-5 h-5 rounded cursor-pointer border border-slate-600 bg-transparent"
                            title="Layer Colour"
                          />
                        </div>

                        {/* Pen Weight */}
                        <select
                          value={layer.penWeight}
                          onChange={(e) => updateDraftingLayer(layer.id, { penWeight: Number(e.target.value) })}
                          className="bg-slate-800 border border-slate-700 text-slate-300 text-[11px] rounded px-1.5 py-0.5 outline-none cursor-pointer"
                          title="Pen Weight (mm)"
                        >
                          {PEN_WEIGHT_OPTIONS.map((w) => (
                            <option key={w} value={w}>
                              {w.toFixed(2)} mm
                            </option>
                          ))}
                        </select>

                        {/* Line Type */}
                        <select
                          value={layer.lineType}
                          onChange={(e) => updateDraftingLayer(layer.id, { lineType: e.target.value as any })}
                          className="bg-slate-800 border border-slate-700 text-slate-300 text-[11px] rounded px-1.5 py-0.5 outline-none capitalize cursor-pointer"
                          title="Line Type"
                        >
                          {LINE_TYPE_OPTIONS.map((lt) => (
                            <option key={lt} value={lt}>
                              {lt}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}

          {/* Add Layer Section */}
          {showAddForm ? (
            <form onSubmit={handleCreateLayer} className="p-4 border border-slate-700 rounded-lg bg-slate-900/60 space-y-3">
              <div className="flex items-center justify-between text-xs font-semibold text-slate-300">
                <span>Create New Layer</span>
                <button
                  type="button"
                  onClick={() => setShowAddForm(false)}
                  className="text-slate-400 hover:text-white"
                >
                  <X size={14} />
                </button>
              </div>

              <div className="grid grid-cols-2 gap-3 text-xs">
                <div>
                  <label className="block text-slate-400 mb-1">Layer Name</label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. A-ANNO-TEXT"
                    value={newLayerName}
                    onChange={(e) => setNewLayerName(e.target.value)}
                    className="w-full bg-slate-800 border border-slate-700 rounded px-2.5 py-1 text-white outline-none focus:border-[#38bdf8]"
                  />
                </div>

                <div>
                  <label className="block text-slate-400 mb-1">Layer Group</label>
                  <select
                    value={newLayerGroup}
                    onChange={(e) => setNewLayerGroup(e.target.value)}
                    className="w-full bg-slate-800 border border-slate-700 rounded px-2.5 py-1 text-white outline-none"
                  >
                    {layerGroups.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-slate-400 mb-1">Pen Weight</label>
                  <select
                    value={newLayerWeight}
                    onChange={(e) => setNewLayerWeight(Number(e.target.value))}
                    className="w-full bg-slate-800 border border-slate-700 rounded px-2.5 py-1 text-white outline-none"
                  >
                    {PEN_WEIGHT_OPTIONS.map((w) => (
                      <option key={w} value={w}>
                        {w.toFixed(2)} mm
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-slate-400 mb-1">Line Type</label>
                  <select
                    value={newLayerType}
                    onChange={(e) => setNewLayerType(e.target.value as any)}
                    className="w-full bg-slate-800 border border-slate-700 rounded px-2.5 py-1 text-white outline-none capitalize"
                  >
                    {LINE_TYPE_OPTIONS.map((lt) => (
                      <option key={lt} value={lt}>
                        {lt}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="flex items-center justify-between pt-2">
                <div className="flex items-center space-x-2">
                  <span className="text-xs text-slate-400">Colour:</span>
                  <input
                    type="color"
                    value={newLayerColor}
                    onChange={(e) => setNewLayerColor(e.target.value)}
                    className="w-6 h-6 rounded cursor-pointer border border-slate-600 bg-transparent"
                  />
                </div>

                <button
                  type="submit"
                  className="px-3 py-1.5 bg-[#0284c7] hover:bg-[#0369a1] text-white rounded text-xs font-semibold shadow transition-colors"
                >
                  Add Layer
                </button>
              </div>
            </form>
          ) : (
            <button
              onClick={() => setShowAddForm(true)}
              className="w-full py-2.5 border border-dashed border-slate-700 hover:border-slate-500 rounded-lg text-slate-400 hover:text-white flex items-center justify-center space-x-1.5 text-xs transition-colors"
            >
              <Plus size={14} />
              <span>Add New Drafting Layer</span>
            </button>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-slate-700/80 bg-[#0f172a]/60 flex items-center justify-between text-xs text-slate-400">
          <span>Active Layer receives new sheet annotations and dimensions.</span>
          <button
            onClick={onClose}
            className="px-4 py-1.5 bg-slate-700 hover:bg-slate-600 text-white rounded text-xs transition-colors"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
};
