import React, { useEffect, useMemo, useState } from 'react';
import { SlidersHorizontal, X, Check } from 'lucide-react';
import { useBimStore } from '../../store/useBimStore';

/**
 * Floor plan view range — the cut plane, per level.
 *
 * This dialog was previously decorative: the four "offset" values were hardcoded strings
 * and Apply sent a fixed `1.2` regardless of what was shown, so nothing the user typed had
 * any effect. It now reads and writes the view's actual `viewRange` and `levelId`.
 *
 * The cut plane is expressed as a height ABOVE the view's level, which is the Revit
 * convention and the only definition that works on a real model: a storey sitting at
 * 1824 ft with an absolute 4 ft cut plane sections empty space. The dialog reports the
 * resulting absolute elevation so that is never a mystery.
 *
 * Values are decimal feet, the application's internal unit.
 */
export const ViewRangeModal: React.FC = () => {
  const {
    isViewRangeModalOpen,
    setViewRangeModalOpen,
    views,
    activeViewId,
    levels,
    sliced2D,
    setViewLevel,
    setViewCut,
    fetch2DSlice,
  } = useBimStore();

  const view = views.find((v) => v.id === activeViewId);
  const viewRange = view?.viewRange ?? (view as any)?.view_range;
  const viewLevelId = view?.levelId ?? (view as any)?.level_id;

  // Derive the storey this plan should draw: the view's own level if set, otherwise the
  // highest storey at or below the current cut — the same rule the backend applies, so
  // the dialog opens showing what is actually being drawn.
  const defaultLevelId = useMemo(() => {
    if (viewLevelId) return viewLevelId;
    if (!levels.length) return undefined;
    const cutElevation = viewRange?.cut ?? 0;
    const below = levels
      .filter((l) => l.elevation <= cutElevation + 1e-6)
      .sort((a, b) => a.elevation - b.elevation);
    return (below.length ? below[below.length - 1] : levels[0]).id;
  }, [viewLevelId, viewRange?.cut, levels]);

  const [levelId, setLevelId] = useState<string | undefined>(defaultLevelId);
  const [cut, setCut] = useState<string>('4.0');
  const [top, setTop] = useState<string>('8.0');
  const [bottom, setBottom] = useState<string>('0.0');
  const [depth, setDepth] = useState<string>('0.0');

  // Re-sync whenever the dialog opens against a different view, rather than only on mount.
  useEffect(() => {
    if (!isViewRangeModalOpen) return;
    setLevelId(defaultLevelId);
    setCut(String(viewRange?.cut ?? 4.0));
    setTop(String(viewRange?.top ?? 8.0));
    setBottom(String(viewRange?.bottom ?? 0.0));
    setDepth(String(viewRange?.viewDepth ?? viewRange?.view_depth ?? 0.0));
  }, [isViewRangeModalOpen, defaultLevelId, view?.id, viewRange?.cut, viewRange?.top, viewRange?.bottom, viewRange?.viewDepth, viewRange?.view_depth]);

  if (!isViewRangeModalOpen) return null;

  const level = levels.find((l) => l.id === levelId);
  const levelElevation = level?.elevation ?? 0;
  const cutNumber = Number(cut);
  const cutValid = Number.isFinite(cutNumber);
  // What the backend actually resolved last time, so the user can confirm the mapping.
  const reportedCutAbsolute = sliced2D?.cut_absolute;
  const reportedLevelName = sliced2D?.level_name;

  const handleApply = () => {
    if (!view) return;
    setViewLevel(view.id, levelId);
    if (cutValid) setViewCut(view.id, cutNumber);
    else fetch2DSlice();
    setViewRangeModalOpen(false);
  };

  const row = (label: string, value: string, onChange: (v: string) => void, emphasised = false) => (
    <tr className={`border-b border-[#333333] ${emphasised ? 'bg-[#094771]/20' : ''}`}>
      <td className={`py-2 ${emphasised ? 'font-bold text-white' : 'font-semibold text-white'}`}>
        {label}
      </td>
      <td className="py-2 text-[#858585]">
        {level ? level.name : 'Associated Level'}
        <span className="text-[#5a5a5a]"> · {levelElevation.toFixed(2)} ft</span>
      </td>
      <td className="py-2 text-right">
        <input
          type="number"
          step="0.25"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-24 bg-[#1e1e1e] border border-[#3c3c3c] rounded px-2 py-1 text-right font-mono text-[#38bdf8] focus:border-[#0284c7] outline-none"
        />
        <span className="ml-1 text-[#5a5a5a]">ft</span>
      </td>
    </tr>
  );

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-xs flex items-center justify-center z-50 p-4">
      <div className="bg-[#252526] border border-[#3c3c3c] rounded-lg shadow-2xl w-full max-w-lg text-[#cccccc] text-xs overflow-hidden">
        <div className="flex items-center justify-between px-4 py-2.5 bg-[#2d2d2d] border-b border-[#3c3c3c]">
          <div className="flex items-center space-x-2 font-semibold text-white">
            <SlidersHorizontal size={15} className="text-[#38bdf8]" />
            <span>Floor Plan View Range</span>
          </div>
          <button
            onClick={() => setViewRangeModalOpen(false)}
            className="p-1 hover:bg-[#3c3c3c] rounded text-[#858585] hover:text-white"
          >
            <X size={15} />
          </button>
        </div>

        <div className="p-4 space-y-4">
          <p className="text-[#9ca3af] text-[11px] leading-relaxed">
            The view range is a set of horizontal planes that control what a plan view
            shows. Offsets are measured <span className="text-[#d4d4d4]">above the
            level</span>, as in Revit.
          </p>

          <div className="flex items-center space-x-3">
            <label className="text-[11px] font-semibold text-white whitespace-nowrap">
              Associated Level
            </label>
            <select
              value={levelId ?? ''}
              onChange={(e) => setLevelId(e.target.value || undefined)}
              className="flex-1 bg-[#1e1e1e] border border-[#3c3c3c] rounded px-2 py-1 text-[#cccccc] outline-none focus:border-[#0284c7]"
            >
              <option value="">(auto — infer from the cut)</option>
              {levels.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name} · {l.elevation.toFixed(2)} ft
                </option>
              ))}
            </select>
          </div>

          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-[#3c3c3c] text-left text-[10px] text-[#858585]">
                <th className="py-1">Plane</th>
                <th className="py-1">Level</th>
                <th className="py-1 text-right">Offset</th>
              </tr>
            </thead>
            <tbody>
              {row('Top', top, setTop)}
              {row('Cut plane', cut, setCut, true)}
              {row('Bottom', bottom, setBottom)}
              {row('View Depth', depth, setDepth)}
            </tbody>
          </table>

          {/* The absolute elevation is the part that is not obvious, and getting it wrong
              is exactly what made every plan of a real model come back empty. */}
          <div className="text-[10px] text-[#858585] bg-[#1e1e1e] border border-[#333333] rounded px-3 py-2 space-y-0.5">
            <div>
              Cut plane resolves to{' '}
              <span className="font-mono text-[#38bdf8]">
                {cutValid ? (levelElevation + cutNumber).toFixed(2) : '—'}
              </span>{' '}
              ft absolute
            </div>
            {reportedLevelName !== undefined && reportedCutAbsolute !== undefined && (
              <div className="text-[#5a5a5a]">
                Currently drawn: {reportedLevelName ?? 'no level'} at{' '}
                {Number(reportedCutAbsolute).toFixed(2)} ft
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center justify-end px-4 py-3 bg-[#2d2d2d] border-t border-[#3c3c3c] space-x-2">
          <button
            onClick={() => setViewRangeModalOpen(false)}
            className="px-3 py-1.5 bg-[#3c3c3c] hover:bg-[#4a4a4a] text-white rounded"
          >
            Cancel
          </button>
          <button
            onClick={handleApply}
            disabled={!view}
            className="flex items-center space-x-1 px-4 py-1.5 bg-[#0284c7] hover:bg-[#0369a1] disabled:opacity-50 text-white font-semibold rounded"
          >
            <Check size={14} />
            <span>Apply View Range</span>
          </button>
        </div>
      </div>
    </div>
  );
};
