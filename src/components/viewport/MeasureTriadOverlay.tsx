/**
 * 3D Measurement Triad & Coordinate Overlay
 * Adopted from N:\lapin\apps\viewer\src\components\viewer\tools\MeasureHudReadouts.tsx
 *
 * Renders on-screen measurement line, triad axis lock indicator, and live coordinate deltas.
 */

import React from 'react';
import * as THREE from 'three';
import { Measurement3DState } from './measure3D';
import { formatLength } from '../../utils/units';
import { useBimStore } from '../../store/useBimStore';

export interface MeasureTriadOverlayProps {
  measurement: Measurement3DState | null;
  camera: THREE.Camera | null;
  canvasWidth: number;
  canvasHeight: number;
}

export const MeasureTriadOverlay: React.FC<MeasureTriadOverlayProps> = ({
  measurement,
  camera,
  canvasWidth,
  canvasHeight,
}) => {
  const { displayUnit } = useBimStore();

  if (!measurement || !camera || canvasWidth <= 0 || canvasHeight <= 0) {
    return null;
  }

  const project = (pt: [number, number, number]): [number, number] | null => {
    const v = new THREE.Vector3(pt[0], pt[1], pt[2]).project(camera);
    if (v.z > 1.0) return null; // Behind camera
    const sx = ((v.x + 1) / 2) * canvasWidth;
    const sy = ((-v.y + 1) / 2) * canvasHeight;
    return [sx, sy];
  };

  const p0 = project(measurement.start);
  const p1 = project(measurement.current);

  if (!p0 || !p1) return null;

  const midX = (p0[0] + p1[0]) / 2;
  const midY = (p0[1] + p1[1]) / 2;

  // Triad axis colors matching Lapin / IFC standard
  const axisColor =
    measurement.activeAxis === 'x'
      ? '#ef4444' // Red
      : measurement.activeAxis === 'y'
      ? '#22c55e' // Green
      : measurement.activeAxis === 'z'
      ? '#3b82f6' // Blue
      : '#38bdf8'; // Default sky blue

  return (
    <div className="absolute inset-0 pointer-events-none z-25 overflow-hidden">
      <svg className="w-full h-full">
        {/* Shadow Line */}
        <line
          x1={p0[0]}
          y1={p0[1]}
          x2={p1[0]}
          y2={p1[1]}
          stroke="black"
          strokeWidth="3.5"
          opacity="0.4"
        />
        {/* Main Measurement Line */}
        <line
          x1={p0[0]}
          y1={p0[1]}
          x2={p1[0]}
          y2={p1[1]}
          stroke={axisColor}
          strokeWidth="2"
          strokeDasharray={measurement.isOrthogonalLocked ? 'none' : '4 3'}
        />
        {/* Start Point Marker */}
        <circle cx={p0[0]} cy={p0[1]} r="4" fill={axisColor} stroke="white" strokeWidth="1.5" />
        {/* End Point Marker */}
        <circle cx={p1[0]} cy={p1[1]} r="4" fill={axisColor} stroke="white" strokeWidth="1.5" />
      </svg>

      {/* Floating Readout Pill */}
      <div
        className="absolute -translate-x-1/2 -translate-y-1/2 px-2.5 py-1 rounded-lg text-xs font-mono font-medium bg-stone-900/90 border border-stone-700/80 text-stone-100 backdrop-blur-md shadow-xl flex flex-col items-center gap-0.5 animate-fade-in"
        style={{ left: `${midX}px`, top: `${midY - 24}px` }}
      >
        <div className="flex items-center gap-1.5 font-bold text-sky-300">
          <span>{formatLength(measurement.directDistance, displayUnit)}</span>
          {measurement.activeAxis && (
            <span
              className="text-[10px] px-1 rounded uppercase font-bold text-white"
              style={{ backgroundColor: axisColor }}
            >
              {measurement.activeAxis}-axis
            </span>
          )}
        </div>
        <div className="text-[10px] text-stone-400 flex items-center gap-2">
          <span>ΔX: {formatLength(Math.abs(measurement.deltaX), displayUnit)}</span>
          <span>ΔY: {formatLength(Math.abs(measurement.deltaY), displayUnit)}</span>
          <span>ΔZ: {formatLength(Math.abs(measurement.deltaZ), displayUnit)}</span>
        </div>
      </div>
    </div>
  );
};
