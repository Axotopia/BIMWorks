/**
 * Viewport Visibility and Status Chips
 * Adopted from N:\lapin\apps\viewer\src\components\viewport-ui\hud\VisibilityChips.tsx
 *
 * Renders floating, interactive HUD badges at top-left:
 * - Isolation count with instant reset
 * - Hidden count with unhide-all action
 * - Section Box / Cut active indicator
 * - Perspective / Orthographic projection switcher
 * - Snaps OFF alert badge
 * - Working plane lock badge
 */

import React from 'react';
import { EyeOff, Box, Camera, Magnet, Lock, X } from 'lucide-react';
import { useBimStore } from '../../../store/useBimStore';

export const VisibilityChips: React.FC = () => {
  const {
    hiddenGuids,
    isolatedGuids,
    resetTempVisibility,
    sectionBox,
    toggleSectionBox,
    cameraProjection,
    toggleCameraProjection,
    snapsEnabled,
    toggleSnaps,
    planeLock,
    setPlaneLock,
  } = useBimStore();

  const isIsolated = isolatedGuids && isolatedGuids.length > 0;
  const isHidden = hiddenGuids && hiddenGuids.length > 0;
  const isSectionActive = Boolean(sectionBox?.enabled);
  const isSnapsDisabled = !snapsEnabled;
  const isPlaneLocked = Boolean(planeLock);

  return (
    <div className="flex flex-col items-start gap-1.5 pointer-events-auto">
      {/* Isolation Badge */}
      {isIsolated && (
        <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-amber-950/80 border border-amber-600/70 text-amber-200 backdrop-blur-md shadow-lg animate-fade-in">
          <EyeOff size={13} className="text-amber-400" />
          <span>Isolated: {isolatedGuids.length}</span>
          <button
            onClick={resetTempVisibility}
            title="Reset Isolation (Show All)"
            className="ml-1 p-0.5 rounded-full hover:bg-amber-800/80 text-amber-300 hover:text-white transition-colors"
          >
            <X size={12} />
          </button>
        </div>
      )}

      {/* Hidden Elements Badge */}
      {isHidden && !isIsolated && (
        <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-stone-900/85 border border-stone-700/80 text-stone-200 backdrop-blur-md shadow-lg animate-fade-in">
          <EyeOff size={13} className="text-stone-400" />
          <span>Hidden: {hiddenGuids.length}</span>
          <button
            onClick={resetTempVisibility}
            title="Unhide All"
            className="ml-1 p-0.5 rounded-full hover:bg-stone-700 text-stone-400 hover:text-white transition-colors"
          >
            <X size={12} />
          </button>
        </div>
      )}

      {/* Section Box Badge */}
      {isSectionActive && (
        <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-sky-950/80 border border-sky-600/70 text-sky-200 backdrop-blur-md shadow-lg animate-fade-in">
          <Box size={13} className="text-sky-400" />
          <span>Section Box Active</span>
          <button
            onClick={toggleSectionBox}
            title="Turn Off Section Box"
            className="ml-1 p-0.5 rounded-full hover:bg-sky-800/80 text-sky-300 hover:text-white transition-colors"
          >
            <X size={12} />
          </button>
        </div>
      )}

      {/* Camera Projection Toggle Chip */}
      <button
        onClick={toggleCameraProjection}
        title="Toggle Camera Projection (Perspective / Orthographic)"
        className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-stone-900/85 hover:bg-stone-800/90 border border-stone-700/80 text-stone-300 hover:text-white backdrop-blur-md shadow-lg transition-all"
      >
        <Camera size={13} className="text-indigo-400" />
        <span className="capitalize">{cameraProjection}</span>
      </button>

      {/* Snaps OFF Warning Chip */}
      {isSnapsDisabled && (
        <button
          onClick={toggleSnaps}
          title="Click to Enable Snaps"
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-rose-950/80 hover:bg-rose-900/90 border border-rose-600/80 text-rose-200 backdrop-blur-md shadow-lg transition-all"
        >
          <Magnet size={13} className="text-rose-400" />
          <span>Snaps: OFF</span>
        </button>
      )}

      {/* Working Plane Lock Chip */}
      {isPlaneLocked && (
        <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-purple-950/80 border border-purple-600/70 text-purple-200 backdrop-blur-md shadow-lg animate-fade-in">
          <Lock size={13} className="text-purple-400" />
          <span>Plane Lock: {planeLock?.toUpperCase()}</span>
          <button
            onClick={() => setPlaneLock(null)}
            title="Unlock Working Plane"
            className="ml-1 p-0.5 rounded-full hover:bg-purple-800/80 text-purple-300 hover:text-white transition-colors"
          >
            <X size={12} />
          </button>
        </div>
      )}
    </div>
  );
};
