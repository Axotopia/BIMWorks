import React, { useState, useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { useBimStore } from '../../store/useBimStore';
import { formatLength } from '../../utils/units';
import { Crosshair, MapPin, Compass } from 'lucide-react';

export interface SurveyPointOverlayProps {
  cameraRef: React.MutableRefObject<THREE.Camera | null>;
  canvasRef: React.MutableRefObject<HTMLCanvasElement | null>;
  cameraTick: number;
  cursorWorldPoint?: [number, number, number] | null;
}

export const SurveyPointOverlay: React.FC<SurveyPointOverlayProps> = ({
  cameraRef,
  canvasRef,
  cameraTick,
  cursorWorldPoint,
}) => {
  const { georeference, setGeoreferenceModalOpen, displayUnit, levels } = useBimStore();
  const [showMarkers, setShowMarkers] = useState<boolean>(() => {
    try {
      return localStorage.getItem('bimworks.coords') !== 'off';
    } catch {
      return true;
    }
  });

  const toggleMarkers = () => {
    const next = !showMarkers;
    setShowMarkers(next);
    try {
      localStorage.setItem('bimworks.coords', next ? 'on' : 'off');
    } catch {}
  };

  // Positions in model space (meters)
  // Project Base Point is at (0, 0, 0)
  const basePointWorld = useMemo(() => new THREE.Vector3(0, 0, 0), []);
  // Survey Point: if georeference has a relative offset or benchmark, use it; default is (0, 0, 0)
  const isCoincident = true; // In standard models without detached site transform, both share origin

  // Screen projections
  const [projectedBase, setProjectedBase] = useState<{ x: number; y: number; visible: boolean }>({
    x: 0,
    y: 0,
    visible: false,
  });

  useEffect(() => {
    const cam = cameraRef.current;
    const canvas = canvasRef.current;
    if (!cam || !canvas) return;

    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;

    const v = basePointWorld.clone();
    v.project(cam);

    // Behind camera check
    const isVisible = v.z <= 1.0 && v.x >= -1.1 && v.x <= 1.1 && v.y >= -1.1 && v.y <= 1.1;
    const screenX = ((v.x + 1) / 2) * rect.width;
    const screenY = ((-v.y + 1) / 2) * rect.height;

    setProjectedBase({
      x: screenX,
      y: screenY,
      visible: isVisible && showMarkers,
    });
  }, [cameraTick, showMarkers, cameraRef, canvasRef, basePointWorld]);

  // Current level for cursor elevation
  const currentLevel = useMemo(() => {
    if (!cursorWorldPoint || !levels?.length) return null;
    const z = cursorWorldPoint[2];
    let best = levels[0];
    for (const lvl of levels) {
      if (lvl.elevation <= z + 0.01 && lvl.elevation >= best.elevation) {
        best = lvl;
      }
    }
    return best;
  }, [cursorWorldPoint, levels]);

  return (
    <>
      {/* 3D World Markers (Screen Overlay) */}
      {projectedBase.visible && (
        <div
          style={{ left: `${projectedBase.x}px`, top: `${projectedBase.y}px` }}
          className="absolute -translate-x-1/2 -translate-y-1/2 z-20 pointer-events-auto select-none group flex items-start gap-1"
        >
          {/* Revit Marker SVG: Circle + Crosshairs + Triangle */}
          <button
            onClick={() => setGeoreferenceModalOpen(true)}
            className="w-6 h-6 flex items-center justify-center text-cyan-400 hover:text-cyan-300 transition-colors drop-shadow-[0_2px_4px_rgba(0,0,0,0.8)] cursor-pointer"
            title="Project Base Point & Survey Point (Click to configure georeferencing)"
          >
            <svg viewBox="0 0 20 20" className="w-5 h-5 overflow-visible">
              {/* Outer Circle */}
              <circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" strokeWidth="1.5" />
              {/* Crosshairs (Project Base Point) */}
              <path d="M10 1v18M1 10h18" stroke="#38bdf8" strokeWidth="1.25" />
              {/* Inscribed Triangle (Survey Point) */}
              <path d="M10 4.5 15 13.5H5Z" fill="none" stroke="#22d3ee" strokeWidth="1.25" />
            </svg>
          </button>

          {/* Marker Label Pill */}
          <div className="flex flex-col gap-0.5 bg-[#1e1e1e]/90 backdrop-blur px-2 py-1 rounded border border-[#3c3c3c] text-[10px] text-white shadow-xl pointer-events-auto group-hover:border-cyan-500/50 transition-all">
            <div className="flex items-center gap-1 font-semibold text-cyan-300">
              <span>Project Base Point & Survey Point</span>
            </div>
            <div className="text-[9px] font-mono text-slate-300">
              (0, 0, 0) · {georeference.projected_crs ? georeference.projected_crs : 'Local Origin'}
            </div>
          </div>
        </div>
      )}

      {/* Coordinate & Georeference HUD (bottom right, beside ViewCube) */}
      <div className="absolute right-[9.5rem] bottom-3 z-10 flex items-start gap-2 bg-[#1e1e1e]/90 backdrop-blur px-3 py-2 rounded-lg border border-[#3c3c3c] text-xs font-mono text-slate-200 shadow-xl pointer-events-auto select-none">
        <div className="flex flex-col gap-0.5">
          {/* Level relative elevation */}
          {currentLevel && cursorWorldPoint ? (
            <div className="flex items-center gap-1.5 text-emerald-400 font-semibold text-[11px]">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
              <span>
                {currentLevel.name} (+{formatLength(cursorWorldPoint[2] - currentLevel.elevation, displayUnit)})
              </span>
            </div>
          ) : (
            <div className="flex items-center gap-1.5 text-slate-400 text-[11px]">
              <Compass size={12} className="text-cyan-400" />
              <span>
                North: {georeference.true_north.toFixed(1)}°
                {georeference.projected_crs ? ` · ${georeference.projected_crs}` : ''}
              </span>
            </div>
          )}

          {/* Project Coordinates */}
          <div className="text-[10px] text-slate-300">
            {cursorWorldPoint ? (
              <span>
                X: {formatLength(cursorWorldPoint[0], displayUnit)} &nbsp; Y:{' '}
                {formatLength(cursorWorldPoint[1], displayUnit)} &nbsp; Z:{' '}
                {formatLength(cursorWorldPoint[2], displayUnit)}
              </span>
            ) : (
              <span className="text-slate-400">Move cursor in 3D to inspect coordinates</span>
            )}
          </div>

          {/* Real-world Map Grid (if georeferenced) */}
          {georeference.projected_crs && cursorWorldPoint && (
            <div className="text-[9px] text-sky-400">
              E: {(georeference.eastings + cursorWorldPoint[0]).toFixed(3)} m &nbsp; N:{' '}
              {(georeference.northings + cursorWorldPoint[1]).toFixed(3)} m
            </div>
          )}
        </div>

        {/* Visibility Toggle Button */}
        <button
          type="button"
          onClick={toggleMarkers}
          className={`p-1 rounded transition-colors ${
            showMarkers
              ? 'text-cyan-400 hover:text-cyan-300 bg-cyan-950/40'
              : 'text-slate-500 hover:text-slate-400'
          }`}
          title={showMarkers ? 'Hide Base & Survey Points' : 'Show Base & Survey Points'}
          aria-pressed={showMarkers}
        >
          <Crosshair size={14} />
        </button>
      </div>
    </>
  );
};
