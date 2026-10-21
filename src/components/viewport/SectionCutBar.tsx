import React from 'react';
import { Scissors, RefreshCw, X, ArrowUpDown, ArrowLeftRight, Layers, Box } from 'lucide-react';
import { useBimStore } from '../../store/useBimStore';
import { formatLength } from '../../utils/units';

export type CutAxis = 'top' | 'x' | 'y' | 'box';

interface SectionCutBarProps {
  axis: CutAxis;
  offset: number;
  flip: boolean;
  minBound: number;
  maxBound: number;
  onAxisChange: (axis: CutAxis) => void;
  onOffsetChange: (offset: number) => void;
  onFlipToggle: () => void;
  onClose: () => void;
  onAlignToPlan?: () => void;
}

export const SectionCutBar: React.FC<SectionCutBarProps> = ({
  axis,
  offset,
  flip,
  minBound,
  maxBound,
  onAxisChange,
  onOffsetChange,
  onFlipToggle,
  onClose,
  onAlignToPlan,
}) => {
  const { displayUnit, activeViewId, views } = useBimStore();
  const currentView = views.find((v) => v.id === activeViewId);

  const axisTitles: Record<CutAxis, string> = {
    top: 'Plan / Level Cut (Z)',
    x: 'Cross Section (X)',
    y: 'Longitudinal Section (Y)',
    box: '3D Section Box',
  };

  return (
    <div className="absolute top-3 left-1/2 -translate-x-1/2 z-20 flex items-center space-x-3 bg-[#0f172a]/95 backdrop-blur-md border border-sky-500/50 rounded-xl px-4 py-2 text-white shadow-2xl animate-fade-in select-none">
      {/* Icon & Title */}
      <div className="flex items-center space-x-2 pr-2 border-r border-slate-700">
        <Scissors size={15} className="text-pink-400" />
        <span className="text-xs font-bold text-sky-200 uppercase tracking-wide">
          Section Cut
        </span>
      </div>

      {/* Axis Selector Buttons */}
      <div className="flex items-center bg-slate-800/90 rounded-lg p-0.5 border border-slate-700/80">
        <button
          onClick={() => onAxisChange('top')}
          className={`flex items-center space-x-1 px-2.5 py-1 text-[11px] rounded-md font-medium transition-all ${
            axis === 'top'
              ? 'bg-sky-600 text-white shadow-sm'
              : 'text-slate-400 hover:text-slate-200'
          }`}
          title="Cut horizontally (Plan View Cut)"
        >
          <ArrowUpDown size={12} />
          <span>Plan (Z)</span>
        </button>

        <button
          onClick={() => onAxisChange('x')}
          className={`flex items-center space-x-1 px-2.5 py-1 text-[11px] rounded-md font-medium transition-all ${
            axis === 'x'
              ? 'bg-sky-600 text-white shadow-sm'
              : 'text-slate-400 hover:text-slate-200'
          }`}
          title="Cut along X (Side / Cross Section)"
        >
          <ArrowLeftRight size={12} />
          <span>Section (X)</span>
        </button>

        <button
          onClick={() => onAxisChange('y')}
          className={`flex items-center space-x-1 px-2.5 py-1 text-[11px] rounded-md font-medium transition-all ${
            axis === 'y'
              ? 'bg-sky-600 text-white shadow-sm'
              : 'text-slate-400 hover:text-slate-200'
          }`}
          title="Cut along Y (Front / Longitudinal Section)"
        >
          <ArrowUpDown size={12} className="rotate-90" />
          <span>Section (Y)</span>
        </button>

        <button
          onClick={() => onAxisChange('box')}
          className={`flex items-center space-x-1 px-2.5 py-1 text-[11px] rounded-md font-medium transition-all ${
            axis === 'box'
              ? 'bg-sky-600 text-white shadow-sm'
              : 'text-slate-400 hover:text-slate-200'
          }`}
          title="Full 6-sided Section Box"
        >
          <Box size={12} />
          <span>Box</span>
        </button>
      </div>

      {/* Offset Slider & Value (for plane axes) */}
      {axis !== 'box' && (
        <div className="flex items-center space-x-2 pl-1">
          <input
            type="range"
            min={minBound}
            max={maxBound}
            step={(maxBound - minBound) / 200 || 0.1}
            value={offset}
            onChange={(e) => onOffsetChange(parseFloat(e.target.value))}
            className="w-32 h-1.5 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-sky-400"
          />
          <span className="text-[11px] font-mono text-sky-300 min-w-[50px]">
            {formatLength(offset, displayUnit)}
          </span>
        </div>
      )}

      {/* Flip Button */}
      {axis !== 'box' && (
        <button
          onClick={onFlipToggle}
          className={`flex items-center space-x-1 px-2 py-1 rounded text-[11px] font-medium border transition-colors ${
            flip
              ? 'bg-amber-500/20 text-amber-300 border-amber-500/40'
              : 'bg-slate-800 text-slate-300 border-slate-700 hover:bg-slate-700'
          }`}
          title="Invert cut direction"
        >
          <RefreshCw size={11} className={flip ? 'rotate-180 transition-transform' : ''} />
          <span>Flip</span>
        </button>
      )}

      {/* Align to Current Plan Button */}
      {onAlignToPlan && (
        <button
          onClick={onAlignToPlan}
          className="flex items-center space-x-1 px-2 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white rounded text-[11px] font-medium border border-slate-700 transition-colors"
          title="Set cut height to match active floor plan"
        >
          <Layers size={11} className="text-sky-400" />
          <span>Align to Plan</span>
        </button>
      )}

      {/* Close Cut Button */}
      <button
        onClick={onClose}
        className="p-1 hover:bg-slate-800 text-slate-400 hover:text-white rounded transition-colors ml-1"
        title="Turn off Section Cut"
      >
        <X size={15} />
      </button>
    </div>
  );
};
