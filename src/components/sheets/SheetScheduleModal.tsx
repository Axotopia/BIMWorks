import React, { useState } from 'react';
import { X, Table, DoorOpen, AppWindow, Copy, Check, Download } from 'lucide-react';
import { BimElement, LevelData } from '../../types/bim';

interface SheetScheduleModalProps {
  isOpen: boolean;
  onClose: () => void;
  elements: BimElement[];
  levels: LevelData[];
  onPlaceOnSheet?: (scheduleSvg: string) => void;
}

export const SheetScheduleModal: React.FC<SheetScheduleModalProps> = ({
  isOpen,
  onClose,
  elements,
  levels,
}) => {
  const [activeTab, setActiveTab] = useState<'doors' | 'windows'>('doors');
  const [copied, setCopied] = useState(false);

  if (!isOpen) return null;

  const doors = elements.filter((e) => e.ifc_class === 'IfcDoor');
  const windows = elements.filter((e) => e.ifc_class === 'IfcWindow');

  const activeItems = activeTab === 'doors' ? doors : windows;

  const formatFtIn = (decimalFeet?: number): string => {
    if (decimalFeet == null || isNaN(decimalFeet)) return '—';
    const totalInches = Math.round(decimalFeet * 12);
    const feet = Math.floor(totalInches / 12);
    const inches = totalInches % 12;
    return `${feet}'-${inches}"`;
  };

  const getLevelName = (levelId?: string): string => {
    if (!levelId) return 'Level 1';
    const lvl = levels.find((l) => l.id === levelId);
    return lvl ? lvl.name : 'Level 1';
  };

  const handleCopyCsv = () => {
    const headers = ['Mark/Tag', 'Type Name', 'Width', 'Height', 'Level', 'GUID'];
    const rows = activeItems.map((item, idx) => [
      item.tag || `${activeTab === 'doors' ? 'D' : 'W'}${String(idx + 1).padStart(2, '0')}`,
      item.name || (activeTab === 'doors' ? 'Single Flush Door' : 'Fixed Window'),
      formatFtIn(item.width || (activeTab === 'doors' ? 3.0 : 4.0)),
      formatFtIn(item.height || (activeTab === 'doors' ? 7.0 : 5.0)),
      getLevelName(item.level_id),
      item.guid,
    ]);
    const csvContent = [headers.join('\t'), ...rows.map((r) => r.join('\t'))].join('\n');
    navigator.clipboard.writeText(csvContent);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs">
      <div className="bg-slate-900 border border-slate-700/80 rounded-xl shadow-2xl w-[720px] max-w-[95vw] overflow-hidden flex flex-col animate-in fade-in zoom-in-95 duration-150">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 bg-slate-950/40">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-emerald-500/20 text-emerald-400 flex items-center justify-center border border-emerald-500/30">
              <Table className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-slate-100">Live Component Schedules</h2>
              <p className="text-xs text-slate-400">Door & Window schedules extracted directly from IFC elements</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-200 p-1.5 rounded-lg hover:bg-slate-800 transition"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Tab switcher */}
        <div className="flex items-center gap-2 px-6 pt-4 border-b border-slate-800/80 bg-slate-900">
          <button
            onClick={() => setActiveTab('doors')}
            className={`flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-t-lg border-b-2 transition ${
              activeTab === 'doors'
                ? 'border-indigo-500 text-indigo-400 bg-slate-800/50'
                : 'border-transparent text-slate-400 hover:text-slate-300'
            }`}
          >
            <DoorOpen className="w-3.5 h-3.5" /> Door Schedule ({doors.length})
          </button>
          <button
            onClick={() => setActiveTab('windows')}
            className={`flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-t-lg border-b-2 transition ${
              activeTab === 'windows'
                ? 'border-indigo-500 text-indigo-400 bg-slate-800/50'
                : 'border-transparent text-slate-400 hover:text-slate-300'
            }`}
          >
            <AppWindow className="w-3.5 h-3.5" /> Window Schedule ({windows.length})
          </button>
        </div>

        {/* Table Content */}
        <div className="p-6 max-h-[55vh] overflow-y-auto">
          {activeItems.length === 0 ? (
            <div className="text-center py-12 text-slate-500 text-xs">
              No {activeTab} placed in the current model.
            </div>
          ) : (
            <div className="rounded-lg border border-slate-800 overflow-hidden bg-slate-950/20">
              <table className="w-full text-left text-xs text-slate-300">
                <thead className="bg-slate-800/60 text-slate-400 font-semibold uppercase tracking-wider text-[10px]">
                  <tr>
                    <th className="py-2.5 px-3 w-16 text-center">Mark</th>
                    <th className="py-2.5 px-3">Type</th>
                    <th className="py-2.5 px-3 w-24">Width</th>
                    <th className="py-2.5 px-3 w-24">Height</th>
                    <th className="py-2.5 px-3 w-32">Level</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60 font-mono">
                  {activeItems.map((item, idx) => (
                    <tr key={item.guid} className="hover:bg-slate-800/30 transition-colors">
                      <td className="py-2 px-3 text-center font-bold text-indigo-400">
                        {item.tag || `${activeTab === 'doors' ? 'D' : 'W'}${String(idx + 1).padStart(2, '0')}`}
                      </td>
                      <td className="py-2 px-3 font-sans text-slate-200">
                        {item.name || (activeTab === 'doors' ? 'Single Flush Door' : 'Fixed Window')}
                      </td>
                      <td className="py-2 px-3 text-slate-300">
                        {formatFtIn(item.width || (activeTab === 'doors' ? 3.0 : 4.0))}
                      </td>
                      <td className="py-2 px-3 text-slate-300">
                        {formatFtIn(item.height || (activeTab === 'doors' ? 7.0 : 5.0))}
                      </td>
                      <td className="py-2 px-3 text-slate-400 font-sans text-[11px]">
                        {getLevelName(item.level_id)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-3 border-t border-slate-800 bg-slate-950/40">
          <button
            onClick={handleCopyCsv}
            disabled={activeItems.length === 0}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-300 bg-slate-800 hover:bg-slate-700 rounded-lg transition disabled:opacity-40"
          >
            {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
            {copied ? 'Copied to Clipboard' : 'Copy TSV Table'}
          </button>
          <button
            onClick={onClose}
            className="px-4 py-1.5 text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg transition"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
