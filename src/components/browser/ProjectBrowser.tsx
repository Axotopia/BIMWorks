import React, { useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Eye,
  Box,
  Layers,
  FileSpreadsheet,
  FileText,
  DoorClosed,
  AppWindow,
  Square,
  Grid,
} from 'lucide-react';
import { useBimStore } from '../../store/useBimStore';

export const ProjectBrowser: React.FC = () => {
  const {
    views,
    sheets,
    activeViewId,
    activeSheetId,
    setActiveViewId,
    setActiveSheetId,
    meshes,
  } = useBimStore();

  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({
    views: true,
    floorPlans: true,
    threeD: true,
    elevations: true,
    sections: true,
    sheets: true,
    families: true,
    schedules: false,
  });

  const toggleSection = (key: string) => {
    setExpandedSections((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const handleDragStart = (e: React.DragEvent, viewId: string) => {
    e.dataTransfer.setData('text/plain', JSON.stringify({ type: 'view', viewId }));
  };

  return (
    <div className="h-full w-full bg-[#252526] text-[#cccccc] flex flex-col border-r border-[#3c3c3c] select-none text-xs overflow-hidden">
      {/* Palette Title */}
      <div className="flex items-center justify-between px-3 py-2 bg-[#2d2d2d] border-b border-[#3c3c3c] font-semibold text-[#e1e1e1]">
        <span>Project Browser - Architecture</span>
      </div>

      {/* Tree Content */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1 font-mono text-[11px]">
        {/* Views (All) */}
        <div>
          <div
            onClick={() => toggleSection('views')}
            className="flex items-center space-x-1 py-1 px-1.5 hover:bg-[#333333] rounded cursor-pointer font-bold text-[#e1e1e1]"
          >
            {expandedSections.views ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            <span>Views (all)</span>
          </div>

          {expandedSections.views && (
            <div className="pl-4 space-y-1 mt-0.5 border-l border-[#3a3a3a] ml-2">
              {/* Floor Plans */}
              <div>
                <div
                  onClick={() => toggleSection('floorPlans')}
                  className="flex items-center space-x-1 py-0.5 px-1 hover:bg-[#333333] rounded cursor-pointer text-[#a1a1aa]"
                >
                  {expandedSections.floorPlans ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  <span>Floor Plans</span>
                </div>
                {expandedSections.floorPlans && (
                  <div className="pl-4 space-y-0.5">
                    {views
                      .filter((v) => v.type === 'floor_plan')
                      .map((v) => (
                        <div
                          key={v.id}
                          draggable
                          onDragStart={(e) => handleDragStart(e, v.id)}
                          onDoubleClick={() => setActiveViewId(v.id)}
                          onClick={() => setActiveViewId(v.id)}
                          className={`flex items-center space-x-1.5 py-1 px-1.5 rounded cursor-pointer ${
                            activeViewId === v.id
                              ? 'bg-[#094771] text-white font-semibold'
                              : 'hover:bg-[#2d2d2d] text-[#d4d4d4]'
                          }`}
                        >
                          <Layers size={13} className="text-[#a855f7]" />
                          <span>{v.name}</span>
                        </div>
                      ))}
                  </div>
                )}
              </div>

              {/* 3D Views */}
              <div>
                <div
                  onClick={() => toggleSection('threeD')}
                  className="flex items-center space-x-1 py-0.5 px-1 hover:bg-[#333333] rounded cursor-pointer text-[#a1a1aa]"
                >
                  {expandedSections.threeD ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  <span>3D Views</span>
                </div>
                {expandedSections.threeD && (
                  <div className="pl-4 space-y-0.5">
                    {views
                      .filter((v) => v.type === '3d')
                      .map((v) => (
                        <div
                          key={v.id}
                          onDoubleClick={() => setActiveViewId(v.id)}
                          onClick={() => setActiveViewId(v.id)}
                          className={`flex items-center space-x-1.5 py-1 px-1.5 rounded cursor-pointer ${
                            activeViewId === v.id
                              ? 'bg-[#094771] text-white font-semibold'
                              : 'hover:bg-[#2d2d2d] text-[#d4d4d4]'
                          }`}
                        >
                          <Box size={13} className="text-[#38bdf8]" />
                          <span>{v.name}</span>
                        </div>
                      ))}
                  </div>
                )}
              </div>

              {/* Sections */}
              <div>
                <div
                  onClick={() => toggleSection('sections')}
                  className="flex items-center space-x-1 py-0.5 px-1 hover:bg-[#333333] rounded cursor-pointer text-[#a1a1aa]"
                >
                  {expandedSections.sections ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  <span>Sections</span>
                </div>
                {expandedSections.sections && (
                  <div className="pl-4 space-y-0.5">
                    {views
                      .filter((v) => v.type === 'section')
                      .map((v) => (
                        <div
                          key={v.id}
                          draggable
                          onDragStart={(e) => handleDragStart(e, v.id)}
                          onDoubleClick={() => setActiveViewId(v.id)}
                          onClick={() => setActiveViewId(v.id)}
                          className={`flex items-center space-x-1.5 py-1 px-1.5 rounded cursor-pointer ${
                            activeViewId === v.id
                              ? 'bg-[#094771] text-white font-semibold'
                              : 'hover:bg-[#2d2d2d] text-[#d4d4d4]'
                          }`}
                        >
                          <Eye size={13} className="text-[#f97316]" />
                          <span>{v.name}</span>
                        </div>
                      ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Sheets (All) */}
        <div>
          <div
            onClick={() => toggleSection('sheets')}
            className="flex items-center space-x-1 py-1 px-1.5 hover:bg-[#333333] rounded cursor-pointer font-bold text-[#e1e1e1]"
          >
            {expandedSections.sheets ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            <span>Sheets (all)</span>
          </div>

          {expandedSections.sheets && (
            <div className="pl-4 space-y-0.5 mt-0.5 border-l border-[#3a3a3a] ml-2">
              {sheets.map((s) => (
                <div
                  key={s.id}
                  onDoubleClick={() => setActiveSheetId(s.id)}
                  onClick={() => setActiveSheetId(s.id)}
                  className={`flex items-center space-x-1.5 py-1 px-1.5 rounded cursor-pointer ${
                    activeSheetId === s.id
                      ? 'bg-[#094771] text-white font-semibold'
                      : 'hover:bg-[#2d2d2d] text-[#d4d4d4]'
                  }`}
                >
                  <FileSpreadsheet size={13} className="text-[#10b981]" />
                  <span>
                    {s.sheetNumber} - {s.sheetTitle}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Families / IFC Types */}
        <div>
          <div
            onClick={() => toggleSection('families')}
            className="flex items-center space-x-1 py-1 px-1.5 hover:bg-[#333333] rounded cursor-pointer font-bold text-[#e1e1e1]"
          >
            {expandedSections.families ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            <span>Families &amp; IFC Types</span>
          </div>

          {expandedSections.families && (
            <div className="pl-4 space-y-1 mt-0.5 border-l border-[#3a3a3a] ml-2 text-[10px] text-[#9ca3af]">
              <div className="flex items-center space-x-1 py-0.5">
                <Box size={11} className="text-[#60a5fa]" />
                <span>IfcWallStandardCase (Basic Wall)</span>
              </div>
              <div className="flex items-center space-x-1 py-0.5">
                <DoorClosed size={11} className="text-[#f97316]" />
                <span>IfcDoor (Single Flush)</span>
              </div>
              <div className="flex items-center space-x-1 py-0.5">
                <AppWindow size={11} className="text-[#38bdf8]" />
                <span>IfcWindow (Fixed Window)</span>
              </div>
              <div className="flex items-center space-x-1 py-0.5">
                <Square size={11} className="text-[#a855f7]" />
                <span>IfcSlab (Floor Slab)</span>
              </div>
              <div className="flex items-center space-x-1 py-0.5">
                <Grid size={11} className="text-[#eab308]" />
                <span>IfcGrid (Datum Grid)</span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
