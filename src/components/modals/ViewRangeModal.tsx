import React, { useState } from 'react';
import { SlidersHorizontal, X, Check } from 'lucide-react';
import { useBimStore } from '../../store/useBimStore';

export const ViewRangeModal: React.FC = () => {
  const { isViewRangeModalOpen, setViewRangeModalOpen, fetch2DSlice } = useBimStore();

  const [topOffset, setTopOffset] = useState('7\'-6" (2300 mm)');
  const [cutOffset, setCutOffset] = useState('4\'-0" (1200 mm)');
  const [bottomOffset, setBottomOffset] = useState('0\'-0" (0 mm)');
  const [depthOffset, setDepthOffset] = useState('0\'-0" (0 mm)');

  if (!isViewRangeModalOpen) return null;

  const handleApply = () => {
    fetch2DSlice(1.2);
    setViewRangeModalOpen(false);
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-xs flex items-center justify-center z-50 p-4">
      <div className="bg-[#252526] border border-[#3c3c3c] rounded-lg shadow-2xl w-full max-w-md text-[#cccccc] text-xs overflow-hidden">
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
            The view range is a set of horizontal planes that control the visibility and display of objects in a plan view.
          </p>

          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-[#3c3c3c] text-left text-[10px] text-[#858585]">
                <th className="py-1">Plane</th>
                <th className="py-1">Level</th>
                <th className="py-1 text-right">Offset</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-[#333333]">
                <td className="py-2 font-semibold text-white">Top</td>
                <td className="py-2 text-[#858585]">Associated Level (Level 1)</td>
                <td className="py-2 text-right font-mono text-[#38bdf8]">{topOffset}</td>
              </tr>
              <tr className="border-b border-[#333333] bg-[#094771]/20">
                <td className="py-2 font-bold text-white">Cut plane</td>
                <td className="py-2 text-[#858585]">Associated Level (Level 1)</td>
                <td className="py-2 text-right font-mono text-[#38bdf8] font-bold">{cutOffset}</td>
              </tr>
              <tr className="border-b border-[#333333]">
                <td className="py-2 font-semibold text-white">Bottom</td>
                <td className="py-2 text-[#858585]">Associated Level (Level 1)</td>
                <td className="py-2 text-right font-mono text-[#38bdf8]">{bottomOffset}</td>
              </tr>
              <tr className="border-b border-[#333333]">
                <td className="py-2 font-semibold text-white">View Depth</td>
                <td className="py-2 text-[#858585]">Associated Level (Level 1)</td>
                <td className="py-2 text-right font-mono text-[#38bdf8]">{depthOffset}</td>
              </tr>
            </tbody>
          </table>
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
            className="flex items-center space-x-1 px-4 py-1.5 bg-[#0284c7] hover:bg-[#0369a1] text-white font-semibold rounded"
          >
            <Check size={14} />
            <span>Apply View Range</span>
          </button>
        </div>
      </div>
    </div>
  );
};
