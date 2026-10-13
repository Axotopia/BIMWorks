import React, { useEffect } from 'react';
import { Ribbon } from './components/ribbon/Ribbon';
import { Workspace } from './components/layout/Workspace';
import { StatusBar } from './components/statusbar/StatusBar';
import { GeoreferenceModal } from './components/modals/GeoreferenceModal';
import { EditTypeModal } from './components/modals/EditTypeModal';
import { ViewRangeModal } from './components/modals/ViewRangeModal';
import { useBimStore } from './store/useBimStore';

export const App: React.FC = () => {
  const {
    fetchProjectState,
    fetchGeometry,
    fetch2DSlice,
    handleKeyStroke,
    selectedGuid,
    deleteElement,
    exportIfc,
  } = useBimStore();

  // Initial load
  useEffect(() => {
    fetchProjectState();
    fetchGeometry();
    fetch2DSlice();
  }, [fetchProjectState, fetchGeometry, fetch2DSlice]);

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

      // Handle Ctrl+S for Save IFC
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        exportIfc();
        return;
      }

      // Handle Delete key
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedGuid) {
          e.preventDefault();
          deleteElement(selectedGuid);
          return;
        }
      }

      // Pass single character or Escape to hotkey engine
      if (e.key.length === 1 || e.key === 'Escape') {
        handleKeyStroke(e.key);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyStroke, selectedGuid, deleteElement, exportIfc]);

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-[#1e1e1e] text-[#cccccc] font-sans">
      {/* 1. Revit Categorized Tabbed Ribbon */}
      <Ribbon />

      {/* 2. Dockview MDI Workspace (Browser, Palettes, 3D/2D Viewports, Sheets) */}
      <Workspace />

      {/* 3. View Control & Status Bar */}
      <StatusBar />

      {/* 4. Modals */}
      <GeoreferenceModal />
      <EditTypeModal />
      <ViewRangeModal />
    </div>
  );
};

export default App;
