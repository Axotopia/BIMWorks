import React, { useState, useMemo } from 'react';
import { FileSpreadsheet, X, Download, Filter } from 'lucide-react';
import { useBimStore } from '../../store/useBimStore';
import { formatLength, formatArea, formatVolume } from '../../utils/units';

interface ScheduleModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialCategory?: 'wall' | 'door' | 'window';
}

export const ScheduleModal: React.FC<ScheduleModalProps> = ({
  isOpen,
  onClose,
  initialCategory = 'wall',
}) => {
  const { elements, types, displayUnit } = useBimStore();
  const [category, setCategory] = useState<'wall' | 'door' | 'window'>(initialCategory);

  React.useEffect(() => {
    if (initialCategory) setCategory(initialCategory);
  }, [initialCategory]);

  const items = useMemo(() => {
    const all = Object.values(elements);
    if (category === 'wall') {
      return all.filter((e) => e.ifc_class === 'IfcWall' || e.ifc_class === 'IfcWallStandardCase');
    }
    if (category === 'door') {
      return all.filter((e) => e.ifc_class === 'IfcDoor');
    }
    if (category === 'window') {
      return all.filter((e) => e.ifc_class === 'IfcWindow');
    }
    return [];
  }, [elements, category]);

  if (!isOpen) return null;

  // Export as CSV
  const handleExportCsv = () => {
    let headers: string[] = [];
    let rows: string[][] = [];

    if (category === 'wall') {
      headers = ['Mark', 'Type Name', 'Length (ft)', 'Height (ft)', 'Thickness (ft)', 'Area (sq ft)', 'Volume (cu ft)', 'Fire Rating'];
      rows = items.map((e, idx) => {
        const l = e.length || 0;
        const h = e.height || 10;
        const th = e.thickness || 0.8333;
        const t = types.find((typ) => typ.id === e.type_id);
        const fr = t?.parameters?.fire_rating || '2 HR';
        return [
          `W-${idx + 1}`,
          `"${e.name || t?.name || 'Basic Wall'}"`,
          l.toFixed(2),
          h.toFixed(2),
          th.toFixed(3),
          (l * h).toFixed(2),
          (l * h * th).toFixed(2),
          fr,
        ];
      });
    } else if (category === 'door') {
      headers = ['Mark', 'Type Name', 'Host Wall', 'Width (ft)', 'Height (ft)', 'Flipped'];
      rows = items.map((e, idx) => {
        const t = types.find((typ) => typ.id === e.type_id);
        return [
          `D-${idx + 1}`,
          `"${e.name || t?.name || 'Single-Flush Door'}"`,
          e.host_wall_guid ? e.host_wall_guid.slice(0, 8) : 'Unassigned',
          (e.width || 3.0).toFixed(2),
          (e.height || 7.0).toFixed(2),
          e.swing_flipped ? 'Yes' : 'No',
        ];
      });
    } else {
      headers = ['Mark', 'Type Name', 'Host Wall', 'Width (ft)', 'Height (ft)', 'Sill Height (ft)'];
      rows = items.map((e, idx) => {
        const t = types.find((typ) => typ.id === e.type_id);
        return [
          `WN-${idx + 1}`,
          `"${e.name || t?.name || 'Fixed Window'}"`,
          e.host_wall_guid ? e.host_wall_guid.slice(0, 8) : 'Unassigned',
          (e.width || 4.0).toFixed(2),
          (e.height || 4.0).toFixed(2),
          (e.sill_height || 3.0).toFixed(2),
        ];
      });
    }

    const csvContent = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${category}_schedule.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  // Summary calculations
  const totalLength = items.reduce((sum, e) => sum + (e.length || 0), 0);
  const totalArea = items.reduce((sum, e) => sum + (e.length || 0) * (e.height || 10), 0);
  const totalVolume = items.reduce(
    (sum, e) => sum + (e.length || 0) * (e.height || 10) * (e.thickness || 0.8333),
    0
  );

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-xs flex items-center justify-center z-50 p-4">
      <div className="bg-[#ffffff] border border-[#a0a0a0] rounded shadow-2xl w-full max-w-4xl text-[#1e293b] text-xs flex flex-col max-h-[85vh] overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-3.5 py-2 bg-[#f1f5f9] border-b border-[#cbd5e1] select-none">
          <div className="flex items-center space-x-2 font-bold text-[#0f172a]">
            <FileSpreadsheet size={15} className="text-[#0284c7]" />
            <span className="text-[13px]">
              {category === 'wall'
                ? 'Wall Schedule / Quantities'
                : category === 'door'
                ? 'Door Schedule'
                : 'Window Schedule'}
            </span>
            <span className="text-[11px] font-normal text-[#64748b]">({items.length} items)</span>
          </div>
          <button
            onClick={onClose}
            className="p-1 hover:bg-[#e2e8f0] rounded text-[#64748b] hover:text-black"
          >
            <X size={15} />
          </button>
        </div>

        {/* Tab Controls & Toolbar */}
        <div className="px-3.5 py-2 bg-[#f8fafc] border-b border-[#e2e8f0] flex items-center justify-between">
          <div className="flex items-center space-x-1">
            <button
              onClick={() => setCategory('wall')}
              className={`px-3 py-1 rounded text-[11px] font-semibold transition-colors ${
                category === 'wall'
                  ? 'bg-[#0284c7] text-white shadow-xs'
                  : 'bg-white border border-[#cbd5e1] text-[#475569] hover:bg-gray-100'
              }`}
            >
              Wall Schedule
            </button>
            <button
              onClick={() => setCategory('door')}
              className={`px-3 py-1 rounded text-[11px] font-semibold transition-colors ${
                category === 'door'
                  ? 'bg-[#0284c7] text-white shadow-xs'
                  : 'bg-white border border-[#cbd5e1] text-[#475569] hover:bg-gray-100'
              }`}
            >
              Door Schedule
            </button>
            <button
              onClick={() => setCategory('window')}
              className={`px-3 py-1 rounded text-[11px] font-semibold transition-colors ${
                category === 'window'
                  ? 'bg-[#0284c7] text-white shadow-xs'
                  : 'bg-white border border-[#cbd5e1] text-[#475569] hover:bg-gray-100'
              }`}
            >
              Window Schedule
            </button>
          </div>

          <button
            onClick={handleExportCsv}
            className="flex items-center space-x-1 px-2.5 py-1 bg-white hover:bg-[#f1f5f9] border border-[#cbd5e1] rounded text-[11px] font-medium text-[#0f172a] shadow-xs"
          >
            <Download size={12} className="text-[#0284c7]" />
            <span>Export CSV</span>
          </button>
        </div>

        {/* Schedule Table */}
        <div className="flex-1 overflow-auto p-3">
          <table className="w-full text-[11px] border-collapse border border-[#cbd5e1]">
            <thead>
              <tr className="bg-[#f1f5f9] border-b border-[#cbd5e1] text-[#475569] font-bold text-left">
                <th className="py-1.5 px-2 border-r border-[#cbd5e1] w-12 text-center">Mark</th>
                <th className="py-1.5 px-2.5 border-r border-[#cbd5e1]">Family and Type</th>
                {category === 'wall' && (
                  <>
                    <th className="py-1.5 px-2.5 border-r border-[#cbd5e1] text-right">Length</th>
                    <th className="py-1.5 px-2.5 border-r border-[#cbd5e1] text-right">Height</th>
                    <th className="py-1.5 px-2.5 border-r border-[#cbd5e1] text-right">Thickness</th>
                    <th className="py-1.5 px-2.5 border-r border-[#cbd5e1] text-right">Area</th>
                    <th className="py-1.5 px-2.5 border-r border-[#cbd5e1] text-right">Volume</th>
                    <th className="py-1.5 px-2.5 text-center">Fire Rating</th>
                  </>
                )}
                {category === 'door' && (
                  <>
                    <th className="py-1.5 px-2.5 border-r border-[#cbd5e1]">Host Wall</th>
                    <th className="py-1.5 px-2.5 border-r border-[#cbd5e1] text-right">Width</th>
                    <th className="py-1.5 px-2.5 border-r border-[#cbd5e1] text-right">Height</th>
                    <th className="py-1.5 px-2.5 text-center">Hand / Flipped</th>
                  </>
                )}
                {category === 'window' && (
                  <>
                    <th className="py-1.5 px-2.5 border-r border-[#cbd5e1]">Host Wall</th>
                    <th className="py-1.5 px-2.5 border-r border-[#cbd5e1] text-right">Width</th>
                    <th className="py-1.5 px-2.5 border-r border-[#cbd5e1] text-right">Height</th>
                    <th className="py-1.5 px-2.5 text-right">Sill Height</th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {items.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-6 text-center text-[#94a3b8] italic">
                    No elements found in this category.
                  </td>
                </tr>
              ) : (
                items.map((e, idx) => {
                  const t = types.find((typ) => typ.id === e.type_id);
                  const l = e.length || 0;
                  const h = e.height || 10;
                  const th = e.thickness || 0.8333;
                  const fr = t?.parameters?.fire_rating || '2 HR';

                  return (
                    <tr
                      key={e.guid}
                      className="border-b border-[#e2e8f0] hover:bg-[#f8fafc] transition-colors"
                    >
                      <td className="py-1 px-2 border-r border-[#cbd5e1] text-center font-mono font-semibold text-[#64748b]">
                        {category === 'wall'
                          ? `W-${idx + 1}`
                          : category === 'door'
                          ? `D-${idx + 1}`
                          : `WN-${idx + 1}`}
                      </td>
                      <td className="py-1 px-2.5 border-r border-[#cbd5e1] font-medium text-[#0f172a]">
                        {e.name || t?.name || 'Default Type'}
                      </td>
                      {category === 'wall' && (
                        <>
                          <td className="py-1 px-2.5 border-r border-[#cbd5e1] text-right font-mono text-[#0284c7]">
                            {formatLength(l, displayUnit)}
                          </td>
                          <td className="py-1 px-2.5 border-r border-[#cbd5e1] text-right font-mono">
                            {formatLength(h, displayUnit)}
                          </td>
                          <td className="py-1 px-2.5 border-r border-[#cbd5e1] text-right font-mono">
                            {formatLength(th, displayUnit)}
                          </td>
                          <td className="py-1 px-2.5 border-r border-[#cbd5e1] text-right font-mono text-[#16a34a]">
                            {formatArea(l * h, displayUnit)}
                          </td>
                          <td className="py-1 px-2.5 border-r border-[#cbd5e1] text-right font-mono text-[#7c3aed]">
                            {formatVolume(l * h * th, displayUnit)}
                          </td>
                          <td className="py-1 px-2.5 text-center font-semibold text-[#dc2626]">
                            {fr}
                          </td>
                        </>
                      )}
                      {category === 'door' && (
                        <>
                          <td className="py-1 px-2.5 border-r border-[#cbd5e1] font-mono text-[#64748b]">
                            {e.host_wall_guid ? e.host_wall_guid.slice(0, 8) : '—'}
                          </td>
                          <td className="py-1 px-2.5 border-r border-[#cbd5e1] text-right font-mono text-[#0284c7]">
                            {formatLength(e.width || 3.0, displayUnit)}
                          </td>
                          <td className="py-1 px-2.5 border-r border-[#cbd5e1] text-right font-mono">
                            {formatLength(e.height || 7.0, displayUnit)}
                          </td>
                          <td className="py-1 px-2.5 text-center font-medium">
                            {e.swing_flipped ? 'Flipped' : 'Standard'}
                          </td>
                        </>
                      )}
                      {category === 'window' && (
                        <>
                          <td className="py-1 px-2.5 border-r border-[#cbd5e1] font-mono text-[#64748b]">
                            {e.host_wall_guid ? e.host_wall_guid.slice(0, 8) : '—'}
                          </td>
                          <td className="py-1 px-2.5 border-r border-[#cbd5e1] text-right font-mono text-[#0284c7]">
                            {formatLength(e.width || 4.0, displayUnit)}
                          </td>
                          <td className="py-1 px-2.5 border-r border-[#cbd5e1] text-right font-mono">
                            {formatLength(e.height || 4.0, displayUnit)}
                          </td>
                          <td className="py-1 px-2.5 text-right font-mono text-[#ea580c]">
                            {formatLength(e.sill_height || 3.0, displayUnit)}
                          </td>
                        </>
                      )}
                    </tr>
                  );
                })
              )}
            </tbody>
            {category === 'wall' && items.length > 0 && (
              <tfoot>
                <tr className="bg-[#e2e8f0] font-bold text-[#0f172a] border-t-2 border-[#94a3b8]">
                  <td colSpan={2} className="py-1.5 px-2.5 border-r border-[#cbd5e1]">
                    Total ({items.length} walls)
                  </td>
                  <td className="py-1.5 px-2.5 border-r border-[#cbd5e1] text-right font-mono text-[#0284c7]">
                    {formatLength(totalLength, displayUnit)}
                  </td>
                  <td className="py-1.5 px-2.5 border-r border-[#cbd5e1] text-right font-mono">—</td>
                  <td className="py-1.5 px-2.5 border-r border-[#cbd5e1] text-right font-mono">—</td>
                  <td className="py-1.5 px-2.5 border-r border-[#cbd5e1] text-right font-mono text-[#16a34a]">
                    {formatArea(totalArea, displayUnit)}
                  </td>
                  <td className="py-1.5 px-2.5 border-r border-[#cbd5e1] text-right font-mono text-[#7c3aed]">
                    {formatVolume(totalVolume, displayUnit)}
                  </td>
                  <td className="py-1.5 px-2.5 text-center font-mono">—</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end px-3.5 py-2 bg-[#f1f5f9] border-t border-[#cbd5e1]">
          <button
            onClick={onClose}
            className="px-4 py-1 bg-[#0284c7] hover:bg-[#0369a1] text-white font-semibold rounded text-[11px] shadow-xs"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
