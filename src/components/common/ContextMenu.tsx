import React, { useEffect, useRef, useState } from 'react';
import { useBimStore, ZOOM_EXTENTS_EVENT } from '../../store/useBimStore';
import {
  Copy,
  Trash2,
  Maximize2,
  SlidersHorizontal,
  RotateCw,
  Sparkles,
  MousePointer,
  Layers,
  ChevronRight,
  Check,
  X,
  Grid,
} from 'lucide-react';

export interface ContextMenuProps {
  x: number;
  y: number;
  targetGuid: string | null;
  onClose: () => void;
}

export const ContextMenu: React.FC<ContextMenuProps> = ({ x, y, targetGuid, onClose }) => {
  const menuRef = useRef<HTMLDivElement>(null);
  const [showSelectAllSubmenu, setShowSelectAllSubmenu] = useState(false);

  const {
    elements,
    meshes,
    createSimilar,
    flipElementOrientation,
    selectAllInstances,
    handleDeleteKey,
    setEditTypeModalOpen,
    handleKeyStroke,
    setActiveTool,
    toggleSnaps,
    snapsEnabled,
  } = useBimStore();

  const elem = targetGuid ? elements[targetGuid] : null;
  const mesh = targetGuid ? meshes.find((m) => m.guid === targetGuid) : null;
  const ifcClass = elem?.ifc_class || mesh?.ifc_class || '';
  const elementName = elem?.name || mesh?.name || ifcClass;

  const isWall = ifcClass === 'IfcWall' || ifcClass === 'IfcWallStandardCase';
  const isDoor = ifcClass === 'IfcDoor';
  const isWindow = ifcClass === 'IfcWindow';
  const canFlip = isWall || isDoor || isWindow;

  // Dismiss on click outside or Escape
  useEffect(() => {
    const handlePointerDown = (e: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    window.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);

  // Viewport bounds clamping
  const menuWidth = 240;
  const menuHeight = targetGuid ? 280 : 180;
  const clampedX = Math.max(10, Math.min(x, window.innerWidth - menuWidth - 10));
  const clampedY = Math.max(10, Math.min(y, window.innerHeight - menuHeight - 10));

  return (
    <div
      ref={menuRef}
      style={{ left: `${clampedX}px`, top: `${clampedY}px` }}
      className="fixed z-50 bg-[#ffffff] text-[#1e293b] border border-[#cbd5e1] rounded-md shadow-2xl py-1 min-w-[220px] text-xs font-sans select-none animate-in fade-in-50 duration-75"
      onContextMenu={(e) => e.preventDefault()}
    >
      {targetGuid ? (
        <>
          {/* Element Category & Type Title Header */}
          <div className="px-3 py-1.5 border-b border-[#e2e8f0] bg-[#f8fafc] mb-1">
            <div className="text-[10px] uppercase font-bold text-[#0284c7] tracking-wider truncate">
              {ifcClass ? ifcClass.replace('Ifc', '') : 'Element'}
            </div>
            <div className="text-[11px] font-semibold text-[#1e293b] truncate" title={elementName}>
              {elementName || targetGuid.slice(0, 8)}
            </div>
          </div>

          {/* 1. Create Similar (CS) */}
          <button
            onClick={() => {
              createSimilar();
              onClose();
            }}
            className="w-full flex items-center px-3 py-1.5 hover:bg-[#e0f2fe] hover:text-[#0369a1] text-left transition-colors"
          >
            <Sparkles size={13} className="text-[#0284c7] mr-2 shrink-0" />
            <span className="flex-1">Create Similar</span>
            <span className="font-mono text-[10px] text-[#94a3b8] ml-2">CS</span>
          </button>

          {/* 2. Select All Instances with Cascading Submenu */}
          <div
            className="relative"
            onMouseEnter={() => setShowSelectAllSubmenu(true)}
            onMouseLeave={() => setShowSelectAllSubmenu(false)}
          >
            <button
              onClick={() => setShowSelectAllSubmenu(!showSelectAllSubmenu)}
              className="w-full flex items-center px-3 py-1.5 hover:bg-[#e0f2fe] hover:text-[#0369a1] text-left transition-colors"
            >
              <Layers size={13} className="text-[#64748b] mr-2 shrink-0" />
              <span className="flex-1">Select All Instances</span>
              <ChevronRight size={12} className="text-[#94a3b8]" />
            </button>

            {showSelectAllSubmenu && (
              <div className="absolute left-[calc(100%-4px)] top-0 bg-[#ffffff] border border-[#cbd5e1] rounded-md shadow-xl py-1 min-w-[170px] z-50">
                <button
                  onClick={() => {
                    selectAllInstances(ifcClass, true);
                    onClose();
                  }}
                  className="w-full flex items-center px-3 py-1.5 hover:bg-[#e0f2fe] hover:text-[#0369a1] text-left text-xs"
                >
                  <span>Visible in View</span>
                </button>
                <button
                  onClick={() => {
                    selectAllInstances(ifcClass, false);
                    onClose();
                  }}
                  className="w-full flex items-center px-3 py-1.5 hover:bg-[#e0f2fe] hover:text-[#0369a1] text-left text-xs"
                >
                  <span>In Entire Project</span>
                </button>
              </div>
            )}
          </div>

          {/* 3. Flip Orientation / Facing (Space / Flip) */}
          {canFlip && (
            <button
              onClick={() => {
                flipElementOrientation(targetGuid);
                onClose();
              }}
              className="w-full flex items-center px-3 py-1.5 hover:bg-[#e0f2fe] hover:text-[#0369a1] text-left transition-colors"
            >
              <RotateCw size={13} className="text-[#64748b] mr-2 shrink-0" />
              <span className="flex-1">{isDoor ? 'Flip Hand / Swing' : 'Flip Orientation'}</span>
              <span className="font-mono text-[10px] text-[#94a3b8] ml-2">Space</span>
            </button>
          )}

          {/* 4. Element Properties... */}
          <button
            onClick={() => {
              setEditTypeModalOpen(true);
              onClose();
            }}
            className="w-full flex items-center px-3 py-1.5 hover:bg-[#e0f2fe] hover:text-[#0369a1] text-left transition-colors"
          >
            <SlidersHorizontal size={13} className="text-[#64748b] mr-2 shrink-0" />
            <span className="flex-1">Type Properties...</span>
          </button>

          <div className="h-[1px] bg-[#e2e8f0] my-1" />

          {/* 5. Delete (Del) */}
          <button
            onClick={() => {
              handleDeleteKey();
              onClose();
            }}
            className="w-full flex items-center px-3 py-1.5 hover:bg-[#fee2e2] text-[#dc2626] text-left transition-colors"
          >
            <Trash2 size={13} className="text-[#dc2626] mr-2 shrink-0" />
            <span className="flex-1">Delete</span>
            <span className="font-mono text-[10px] text-[#f87171] ml-2">Del</span>
          </button>

          <div className="h-[1px] bg-[#e2e8f0] my-1" />

          {/* 6. Zoom to Fit */}
          <button
            onClick={() => {
              window.dispatchEvent(new CustomEvent(ZOOM_EXTENTS_EVENT));
              onClose();
            }}
            className="w-full flex items-center px-3 py-1.5 hover:bg-[#e0f2fe] hover:text-[#0369a1] text-left transition-colors"
          >
            <Maximize2 size={13} className="text-[#64748b] mr-2 shrink-0" />
            <span className="flex-1">Zoom to Fit</span>
            <span className="font-mono text-[10px] text-[#94a3b8] ml-2">ZE</span>
          </button>
        </>
      ) : (
        <>
          {/* Canvas Background Context Menu */}
          <button
            onClick={() => {
              handleKeyStroke('Escape');
              onClose();
            }}
            className="w-full flex items-center px-3 py-1.5 hover:bg-[#e0f2fe] hover:text-[#0369a1] text-left transition-colors"
          >
            <X size={13} className="text-[#64748b] mr-2 shrink-0" />
            <span className="flex-1">Cancel</span>
            <span className="font-mono text-[10px] text-[#94a3b8] ml-2">Esc</span>
          </button>

          <button
            onClick={() => {
              setActiveTool('select');
              onClose();
            }}
            className="w-full flex items-center px-3 py-1.5 hover:bg-[#e0f2fe] hover:text-[#0369a1] text-left transition-colors"
          >
            <MousePointer size={13} className="text-[#64748b] mr-2 shrink-0" />
            <span className="flex-1">Select / Modify</span>
            <span className="font-mono text-[10px] text-[#94a3b8] ml-2">MD</span>
          </button>

          <div className="h-[1px] bg-[#e2e8f0] my-1" />

          <button
            onClick={() => {
              window.dispatchEvent(new CustomEvent(ZOOM_EXTENTS_EVENT));
              onClose();
            }}
            className="w-full flex items-center px-3 py-1.5 hover:bg-[#e0f2fe] hover:text-[#0369a1] text-left transition-colors"
          >
            <Maximize2 size={13} className="text-[#64748b] mr-2 shrink-0" />
            <span className="flex-1">Zoom to Fit</span>
            <span className="font-mono text-[10px] text-[#94a3b8] ml-2">ZE</span>
          </button>

          <button
            onClick={() => {
              window.dispatchEvent(new CustomEvent(ZOOM_EXTENTS_EVENT));
              onClose();
            }}
            className="w-full flex items-center px-3 py-1.5 hover:bg-[#e0f2fe] hover:text-[#0369a1] text-left transition-colors"
          >
            <Maximize2 size={13} className="text-[#64748b] mr-2 shrink-0" />
            <span className="flex-1">Zoom All to Fit</span>
            <span className="font-mono text-[10px] text-[#94a3b8] ml-2">ZA</span>
          </button>

          <div className="h-[1px] bg-[#e2e8f0] my-1" />

          <button
            onClick={() => {
              toggleSnaps();
              onClose();
            }}
            className="w-full flex items-center px-3 py-1.5 hover:bg-[#e0f2fe] hover:text-[#0369a1] text-left transition-colors"
          >
            <Grid size={13} className="text-[#64748b] mr-2 shrink-0" />
            <span className="flex-1">Snaps ({snapsEnabled ? 'Enabled' : 'Disabled'})</span>
            <span className="font-mono text-[10px] text-[#94a3b8] ml-2">F3</span>
          </button>
        </>
      )}
    </div>
  );
};
