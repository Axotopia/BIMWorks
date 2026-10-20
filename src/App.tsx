import React, { useEffect } from 'react';
import { Ribbon } from './components/ribbon/Ribbon';
import { Workspace } from './components/layout/Workspace';
import { StatusBar } from './components/statusbar/StatusBar';
import { GeoreferenceModal } from './components/modals/GeoreferenceModal';
import { EditTypeModal } from './components/modals/EditTypeModal';
import { ViewRangeModal } from './components/modals/ViewRangeModal';
import { PromptBar } from './components/ai/PromptBar';
import { useBimStore } from './store/useBimStore';
import { ErrorBoundary } from './components/common/ErrorBoundary';

export const App: React.FC = () => {
  const {
    fetchProjectState,
    fetchGeometry,
    fetchStateBundle,
    handleKeyStroke,
    handleDeleteKey,
    exportIfc,
    undo,
    redo,
    cycleTabSelection,
    toggleSnaps,
  } = useBimStore();

  // Initial load.
  //
  // `fetchStateBundle()` rather than `fetch2DSlice()`: the bundle is a superset that
  // also carries `views` and `sheets`, which the Project Browser and the Ribbon render.
  // Nothing fetched them on mount before, so both showed the store's hardcoded seed
  // literals (`view-level-1`, `sheet-a101`, ...) until the user loaded a container —
  // the panels looked populated while describing a project that was not open. The
  // store's `rev` starts undefined, so this first call is a full Response C.
  useEffect(() => {
    fetchProjectState();
    fetchGeometry();
    fetchStateBundle();
  }, [fetchProjectState, fetchGeometry, fetchStateBundle]);

  // Global Keyboard Navigation & Two-Letter Hotkey Engine
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignore if user is typing in an input or textarea
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        e.target instanceof HTMLSelectElement
      ) {
        return;
      }

      // Handle Ctrl+Z for Undo, Ctrl+Y or Ctrl+Shift+Z for Redo (Phase 3.5.2)
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) {
          redo();
        } else {
          undo();
        }
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        redo();
        return;
      }

      // Handle Ctrl+S for Save IFC
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        exportIfc();
        return;
      }

      // Tab key cycles candidate selection (Revit Tab-cycling)
      if (e.key === 'Tab') {
        e.preventDefault();
        cycleTabSelection();
        return;
      }

      // F3 toggles typed object snaps
      if (e.key === 'F3') {
        e.preventDefault();
        toggleSnaps();
        return;
      }

      // Handle Enter/Delete for the active sketch or selection. The sketch-vs-model
      // decision lives in the store (UI-P0-9) so it cannot drift per component.
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        handleDeleteKey();
        return;
      }

      // Pass single character, Escape, or Arrow keys to hotkey engine
      if (e.key.length === 1 || e.key === 'Escape' || e.key.startsWith('Arrow')) {
        handleKeyStroke(e.key);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyStroke, handleDeleteKey, exportIfc, undo, redo, cycleTabSelection, toggleSnaps]);

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-[#f3f4f6] text-[#1e293b] font-sans">
      {/* 1. Revit Categorized Tabbed Ribbon */}
      <Ribbon />

      {/* 2. Dockview MDI Workspace (Browser, Palettes, 3D/2D Viewports, Sheets) */}
      <ErrorBoundary>
        <Workspace />
      </ErrorBoundary>

      {/* 3. Tier-1 In-App Prompt Bar ("Ask/Do" Bar) */}
      <PromptBar />

      {/* 4. View Control & Status Bar */}
      <StatusBar />

      {/* 4. Modals */}
      <GeoreferenceModal />
      <EditTypeModal />
      <ViewRangeModal />
    </div>
  );
};

export default App;
