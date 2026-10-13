import React from 'react';
import { Settings, X, Check } from 'lucide-react';
import { useBimStore } from '../../store/useBimStore';

export const EditTypeModal: React.FC = () => {
  const { isEditTypeModalOpen, setEditTypeModalOpen, selectedGuid, meshes } = useBimStore();

  if (!isEditTypeModalOpen) return null;

  const mesh = meshes.find((m) => m.guid === selectedGuid);
  const typeName = mesh ? mesh.name : 'Basic Wall : Exterior - 10" CMU';

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-xs flex items-center justify-center z-50 p-4">
      <div className="bg-[#252526] border border-[#3c3c3c] rounded-lg shadow-2xl w-full max-w-md text-[#cccccc] text-xs overflow-hidden">
        <div className="flex items-center justify-between px-4 py-2.5 bg-[#2d2d2d] border-b border-[#3c3c3c]">
          <div className="flex items-center space-x-2 font-semibold text-white">
            <Settings size={15} className="text-[#38bdf8]" />
            <span>Type Properties</span>
          </div>
          <button
            onClick={() => setEditTypeModalOpen(false)}
            className="p-1 hover:bg-[#3c3c3c] rounded text-[#858585] hover:text-white"
          >
            <X size={15} />
          </button>
        </div>

        <div className="p-4 space-y-4">
          <div className="bg-[#1e1e1e] p-2.5 rounded border border-[#3c3c3c]">
            <div className="text-[10px] text-[#858585] uppercase font-bold">Family &amp; Type</div>
            <div className="font-semibold text-white text-sm mt-0.5">{typeName}</div>
          </div>

          <table className="w-full text-xs">
            <tbody>
              <tr className="border-b border-[#333333]">
                <td className="py-2 text-[#858585]">Structure Thickness</td>
                <td className="py-2 text-right text-white font-mono">10" (250 mm)</td>
              </tr>
              <tr className="border-b border-[#333333]">
                <td className="py-2 text-[#858585]">Fire Rating</td>
                <td className="py-2 text-right text-white">2 HR</td>
              </tr>
              <tr className="border-b border-[#333333]">
                <td className="py-2 text-[#858585]">Thermal Resistance (R-value)</td>
                <td className="py-2 text-right text-white font-mono">R-19.0</td>
              </tr>
              <tr className="border-b border-[#333333]">
                <td className="py-2 text-[#858585]">Structural Material</td>
                <td className="py-2 text-right text-white">Concrete Masonry Units</td>
              </tr>
              <tr className="border-b border-[#333333]">
                <td className="py-2 text-[#858585]">Function</td>
                <td className="py-2 text-right text-white">Exterior</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div className="flex items-center justify-end px-4 py-3 bg-[#2d2d2d] border-t border-[#3c3c3c] space-x-2">
          <button
            onClick={() => setEditTypeModalOpen(false)}
            className="px-4 py-1.5 bg-[#0284c7] hover:bg-[#0369a1] text-white font-semibold rounded"
          >
            OK
          </button>
        </div>
      </div>
    </div>
  );
};
