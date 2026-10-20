import React, { useState } from 'react';
import { X, Plus, Trash2, Calendar, FileText, Check } from 'lucide-react';
import { SheetRevision } from '../../types/bim';

interface RevisionTableModalProps {
  isOpen: boolean;
  onClose: () => void;
  revisions: SheetRevision[];
  onSave: (revisions: SheetRevision[]) => void;
  defaultDrawnBy?: string;
}

export const RevisionTableModal: React.FC<RevisionTableModalProps> = ({
  isOpen,
  onClose,
  revisions: initialRevisions,
  onSave,
  defaultDrawnBy = 'BIMWorks Architect',
}) => {
  const [revisions, setRevisions] = useState<SheetRevision[]>(() =>
    initialRevisions && initialRevisions.length > 0
      ? [...initialRevisions]
      : [
          {
            id: 'rev-1',
            sequence: 1,
            description: 'INITIAL BIM ISSUE',
            date: new Date().toISOString().slice(0, 10),
            drawnBy: defaultDrawnBy,
          },
        ]
  );

  if (!isOpen) return null;

  const handleAddRow = () => {
    const nextSeq = revisions.length > 0 ? Math.max(...revisions.map((r) => r.sequence)) + 1 : 1;
    const newRev: SheetRevision = {
      id: `rev-${Date.now()}`,
      sequence: nextSeq,
      description: 'DESIGN REVISION',
      date: new Date().toISOString().slice(0, 10),
      drawnBy: defaultDrawnBy,
    };
    setRevisions([...revisions, newRev]);
  };

  const handleUpdate = (id: string, patch: Partial<SheetRevision>) => {
    setRevisions(revisions.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  };

  const handleDelete = (id: string) => {
    setRevisions(revisions.filter((r) => r.id !== id));
  };

  const handleSave = () => {
    onSave(revisions);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs">
      <div className="bg-slate-900 border border-slate-700/80 rounded-xl shadow-2xl w-[640px] max-w-[95vw] overflow-hidden flex flex-col animate-in fade-in zoom-in-95 duration-150">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 bg-slate-950/40">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-indigo-500/20 text-indigo-400 flex items-center justify-center border border-indigo-500/30">
              <FileText className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-slate-100">Sheet Revision History</h2>
              <p className="text-xs text-slate-400">Manage drawing issue revisions displayed on title block</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-200 p-1.5 rounded-lg hover:bg-slate-800 transition"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content Table */}
        <div className="p-6 max-h-[60vh] overflow-y-auto">
          <div className="rounded-lg border border-slate-800 overflow-hidden bg-slate-950/20">
            <table className="w-full text-left text-xs text-slate-300">
              <thead className="bg-slate-800/60 text-slate-400 font-semibold uppercase tracking-wider text-[10px]">
                <tr>
                  <th className="py-2.5 px-3 w-16 text-center">No.</th>
                  <th className="py-2.5 px-3">Description</th>
                  <th className="py-2.5 px-3 w-32">Date</th>
                  <th className="py-2.5 px-3 w-28">Drawn By</th>
                  <th className="py-2.5 px-3 w-12 text-center"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60 font-mono">
                {revisions.map((rev) => (
                  <tr key={rev.id} className="hover:bg-slate-800/30 transition-colors">
                    <td className="py-2 px-3 text-center">
                      <input
                        type="number"
                        value={rev.sequence}
                        onChange={(e) => handleUpdate(rev.id, { sequence: parseInt(e.target.value, 10) || 1 })}
                        className="w-12 bg-slate-900 border border-slate-700 rounded px-1.5 py-1 text-center text-slate-200 focus:outline-hidden focus:border-indigo-500"
                      />
                    </td>
                    <td className="py-2 px-3">
                      <input
                        type="text"
                        value={rev.description}
                        onChange={(e) => handleUpdate(rev.id, { description: e.target.value })}
                        className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-slate-200 focus:outline-hidden focus:border-indigo-500 font-sans text-xs"
                      />
                    </td>
                    <td className="py-2 px-3">
                      <input
                        type="date"
                        value={rev.date}
                        onChange={(e) => handleUpdate(rev.id, { date: e.target.value })}
                        className="w-full bg-slate-900 border border-slate-700 rounded px-1.5 py-1 text-slate-200 focus:outline-hidden focus:border-indigo-500 text-[11px]"
                      />
                    </td>
                    <td className="py-2 px-3">
                      <input
                        type="text"
                        value={rev.drawnBy || ''}
                        onChange={(e) => handleUpdate(rev.id, { drawnBy: e.target.value })}
                        className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-slate-200 focus:outline-hidden focus:border-indigo-500 text-[11px]"
                      />
                    </td>
                    <td className="py-2 px-3 text-center">
                      <button
                        onClick={() => handleDelete(rev.id)}
                        disabled={revisions.length <= 1}
                        className="text-slate-500 hover:text-red-400 p-1 rounded hover:bg-red-500/10 disabled:opacity-30 disabled:hover:text-slate-500 disabled:hover:bg-transparent transition"
                        title="Delete revision"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <button
            onClick={handleAddRow}
            className="mt-3 flex items-center gap-1.5 text-xs text-indigo-400 hover:text-indigo-300 font-medium px-2.5 py-1.5 rounded-lg hover:bg-indigo-500/10 transition"
          >
            <Plus className="w-3.5 h-3.5" /> Add Revision Entry
          </button>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2.5 px-6 py-3 border-t border-slate-800 bg-slate-950/40">
          <button
            onClick={onClose}
            className="px-4 py-1.5 text-xs font-medium text-slate-400 hover:text-slate-200 hover:bg-slate-800 rounded-lg transition"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            className="flex items-center gap-1.5 px-4 py-1.5 text-xs font-semibold bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg shadow-sm transition"
          >
            <Check className="w-3.5 h-3.5" /> Save Changes
          </button>
        </div>
      </div>
    </div>
  );
};
