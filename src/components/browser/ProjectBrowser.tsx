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
  Plus,
  Trash2,
} from 'lucide-react';
import { useBimStore } from '../../store/useBimStore';
import { formatLength } from '../../utils/units';
import { ScheduleModal } from '../modals/ScheduleModal';

export const ProjectBrowser: React.FC = () => {
  const {
    views,
    sheets,
    levels,
    displayUnit,
    activeViewId,
    activeSheetId,
    setActiveViewId,
    setActiveSheetId,
    createSheet,
    deleteSheet,
    meshes,
  } = useBimStore();

  const [isScheduleOpen, setIsScheduleOpen] = useState(false);
  const [scheduleCategory, setScheduleCategory] = useState<'wall' | 'door' | 'window'>('wall');

  // Real IFC class inventory with instance counts, derived from the loaded model.
  // This block previously listed five fixed class/type names regardless of what
  // was actually loaded — static text presented as model content.
  const ifcClassCounts = meshes.reduce<Record<string, number>>((acc, m) => {
    acc[m.ifc_class] = (acc[m.ifc_class] ?? 0) + 1;
    return acc;
  }, {});
  const ifcClassEntries = Object.entries(ifcClassCounts).sort((a, b) => b[1] - a[1]);

  const classIcon = (ifcClass: string) => {
    if (ifcClass === 'IfcDoor') return <DoorClosed size={11} className="text-[#f97316]" />;
    if (ifcClass === 'IfcWindow') return <AppWindow size={11} className="text-[#38bdf8]" />;
    if (ifcClass === 'IfcSlab' || ifcClass === 'IfcRoof')
      return <Square size={11} className="text-[#a855f7]" />;
    if (ifcClass === 'IfcGrid') return <Grid size={11} className="text-[#eab308]" />;
    return <Box size={11} className="text-[#60a5fa]" />;
  };

  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({
    views: true,
    floorPlans: true,
    threeD: true,
    elevations: true,
    sections: true,
    sheets: true,
    levels: true,
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
    <div className="h-full w-full bg-[#ffffff] text-[#1e293b] flex flex-col border-r border-[#dcdcdc] select-none text-xs overflow-hidden font-sans">
      {/* Palette Title */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-[#f0f0f0] border-b border-[#dcdcdc] font-semibold text-[#202020]">
        <span>Project Browser - Architecture</span>
      </div>

      {/* Tree Content */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1 text-[11px]">
        {/* Views (All) */}
        <div>
          <div
            onClick={() => toggleSection('views')}
            className="flex items-center space-x-1 py-1 px-1.5 hover:bg-[#f1f5f9] rounded cursor-pointer font-bold text-[#1e293b]"
          >
            {expandedSections.views ? <ChevronDown size={14} className="text-[#64748b]" /> : <ChevronRight size={14} className="text-[#64748b]" />}
            <span>Views (all)</span>
          </div>

          {expandedSections.views && (
            <div className="pl-4 space-y-1 mt-0.5 border-l border-[#e2e8f0] ml-2">
              {/* Floor Plans */}
              <div>
                <div
                  onClick={() => toggleSection('floorPlans')}
                  className="flex items-center space-x-1 py-0.5 px-1 hover:bg-[#f1f5f9] rounded cursor-pointer text-[#475569] font-medium"
                >
                  {expandedSections.floorPlans ? <ChevronDown size={12} className="text-[#64748b]" /> : <ChevronRight size={12} className="text-[#64748b]" />}
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
                              ? 'bg-[#cce8ff] border border-[#007acc] text-[#094771] font-semibold'
                              : 'hover:bg-[#f1f5f9] text-[#334155]'
                          }`}
                        >
                          <Layers size={13} className="text-[#0284c7]" />
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
                  className="flex items-center space-x-1 py-0.5 px-1 hover:bg-[#f1f5f9] rounded cursor-pointer text-[#475569] font-medium"
                >
                  {expandedSections.threeD ? <ChevronDown size={12} className="text-[#64748b]" /> : <ChevronRight size={12} className="text-[#64748b]" />}
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
                              ? 'bg-[#cce8ff] border border-[#007acc] text-[#094771] font-semibold'
                              : 'hover:bg-[#f1f5f9] text-[#334155]'
                          }`}
                        >
                          <Box size={13} className="text-[#0284c7]" />
                          <span>{v.name}</span>
                        </div>
                      ))}
                  </div>
                )}
              </div>

              {/* Elevations */}
              <div>
                <div
                  onClick={() => toggleSection('elevations')}
                  className="flex items-center space-x-1 py-0.5 px-1 hover:bg-[#f1f5f9] rounded cursor-pointer text-[#475569] font-medium"
                >
                  {expandedSections.elevations ? <ChevronDown size={12} className="text-[#64748b]" /> : <ChevronRight size={12} className="text-[#64748b]" />}
                  <span>Elevations</span>
                </div>
                {expandedSections.elevations && (
                  <div className="pl-4 space-y-0.5">
                    {views
                      .filter((v) => v.type === 'elevation')
                      .map((v) => (
                        <div
                          key={v.id}
                          draggable
                          onDragStart={(e) => handleDragStart(e, v.id)}
                          onDoubleClick={() => setActiveViewId(v.id)}
                          onClick={() => setActiveViewId(v.id)}
                          className={`flex items-center space-x-1.5 py-1 px-1.5 rounded cursor-pointer ${
                            activeViewId === v.id
                              ? 'bg-[#cce8ff] border border-[#007acc] text-[#094771] font-semibold'
                              : 'hover:bg-[#f1f5f9] text-[#334155]'
                          }`}
                        >
                          <Eye size={13} className="text-[#0284c7]" />
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
                  className="flex items-center space-x-1 py-0.5 px-1 hover:bg-[#f1f5f9] rounded cursor-pointer text-[#475569] font-medium"
                >
                  {expandedSections.sections ? <ChevronDown size={12} className="text-[#64748b]" /> : <ChevronRight size={12} className="text-[#64748b]" />}
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
                              ? 'bg-[#cce8ff] border border-[#007acc] text-[#094771] font-semibold'
                              : 'hover:bg-[#f1f5f9] text-[#334155]'
                          }`}
                        >
                          <Eye size={13} className="text-[#ea580c]" />
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
          <div className="flex items-center justify-between py-1 px-1.5 hover:bg-[#f1f5f9] rounded font-bold text-[#1e293b]">
            <div
              onClick={() => toggleSection('sheets')}
              className="flex items-center space-x-1 cursor-pointer flex-1"
            >
              {expandedSections.sheets ? <ChevronDown size={14} className="text-[#64748b]" /> : <ChevronRight size={14} className="text-[#64748b]" />}
              <span>Sheets (all)</span>
            </div>
            <button
              onClick={(e) => {
                e.stopPropagation();
                let nextNum = 'A101';
                const nums = sheets
                  .map((s) => {
                    const match = s.sheetNumber.match(/^([A-Za-z]+)(\d+)$/);
                    return match ? { prefix: match[1], num: parseInt(match[2], 10) } : null;
                  })
                  .filter((n): n is { prefix: string; num: number } => n !== null);
                if (nums.length > 0) {
                  const max = Math.max(...nums.map((n) => n.num));
                  nextNum = `${nums[0].prefix}${max + 1}`;
                }
                createSheet(nextNum, 'Unnamed Sheet', 'ARCH_D');
              }}
              title="New Sheet (Auto-numbered)"
              className="p-0.5 hover:bg-[#e2e8f0] rounded text-[#007acc] hover:text-[#005a9e] transition-colors"
            >
              <Plus size={13} />
            </button>
          </div>

          {expandedSections.sheets && (
            <div className="pl-4 space-y-0.5 mt-0.5 border-l border-[#e2e8f0] ml-2">
              {sheets.map((s) => (
                <div
                  key={s.id}
                  onDoubleClick={() => setActiveSheetId(s.id)}
                  onClick={() => setActiveSheetId(s.id)}
                  className={`group flex items-center justify-between py-1 px-1.5 rounded cursor-pointer ${
                    activeSheetId === s.id
                      ? 'bg-[#cce8ff] border border-[#007acc] text-[#094771] font-semibold'
                      : 'hover:bg-[#f1f5f9] text-[#334155]'
                  }`}
                >
                  <div className="flex items-center space-x-1.5 truncate">
                    <FileSpreadsheet size={13} className="text-[#16a34a] shrink-0" />
                    <span className="truncate">
                      {s.sheetNumber} - {s.sheetTitle}
                    </span>
                  </div>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteSheet(s.id);
                    }}
                    title="Delete Sheet"
                    className="opacity-0 group-hover:opacity-100 p-0.5 hover:bg-red-100 text-red-600 rounded transition-opacity"
                  >
                    <Trash2 size={11} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Schedules / Quantities (P6) */}
        <div>
          <div
            onClick={() => toggleSection('schedules')}
            className="flex items-center space-x-1 py-1 px-1.5 hover:bg-[#f1f5f9] rounded cursor-pointer font-bold text-[#1e293b]"
          >
            {expandedSections.schedules ? <ChevronDown size={14} className="text-[#64748b]" /> : <ChevronRight size={14} className="text-[#64748b]" />}
            <span>Schedules / Quantities</span>
          </div>

          {expandedSections.schedules && (
            <div className="pl-4 space-y-0.5 mt-0.5 border-l border-[#e2e8f0] ml-2">
              <div
                onClick={() => {
                  setScheduleCategory('wall');
                  setIsScheduleOpen(true);
                }}
                className="flex items-center space-x-1.5 py-1 px-1.5 rounded cursor-pointer hover:bg-[#f1f5f9] text-[#334155]"
              >
                <FileText size={13} className="text-[#6366f1]" />
                <span>Wall Schedule</span>
              </div>
              <div
                onClick={() => {
                  setScheduleCategory('door');
                  setIsScheduleOpen(true);
                }}
                className="flex items-center space-x-1.5 py-1 px-1.5 rounded cursor-pointer hover:bg-[#f1f5f9] text-[#334155]"
              >
                <FileText size={13} className="text-[#f97316]" />
                <span>Door Schedule</span>
              </div>
              <div
                onClick={() => {
                  setScheduleCategory('window');
                  setIsScheduleOpen(true);
                }}
                className="flex items-center space-x-1.5 py-1 px-1.5 rounded cursor-pointer hover:bg-[#f1f5f9] text-[#334155]"
              >
                <FileText size={13} className="text-[#0284c7]" />
                <span>Window Schedule</span>
              </div>
            </div>
          )}
        </div>

        {/* Levels / Storeys (Task 2.7) */}
        <div>
          <div
            onClick={() => toggleSection('levels')}
            className="flex items-center space-x-1 py-1 px-1.5 hover:bg-[#f1f5f9] rounded cursor-pointer font-bold text-[#1e293b]"
          >
            {expandedSections.levels ? <ChevronDown size={14} className="text-[#64748b]" /> : <ChevronRight size={14} className="text-[#64748b]" />}
            <span>Levels ({levels.length})</span>
          </div>

          {expandedSections.levels && (
            <div className="pl-4 space-y-0.5 mt-0.5 border-l border-[#e2e8f0] ml-2">
              {levels.map((lvl) => {
                const planView = views.find(
                  (v) => v.levelId === lvl.id || v.name.toLowerCase() === lvl.name.toLowerCase()
                );
                return (
                  <div
                    key={lvl.id}
                    onClick={() => {
                      if (planView) setActiveViewId(planView.id);
                    }}
                    className={`flex items-center justify-between py-1 px-1.5 rounded text-[#334155] ${
                      planView ? 'cursor-pointer hover:bg-[#f1f5f9]' : 'cursor-default'
                    }`}
                  >
                    <div className="flex items-center space-x-1.5">
                      <Layers size={12} className="text-[#0284c7]" />
                      <span className="font-medium">{lvl.name}</span>
                    </div>
                    <span className="font-mono text-[10px] text-[#64748b]">
                      {formatLength(lvl.elevation, displayUnit)}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Families / IFC Types */}
        <div>
          <div
            onClick={() => toggleSection('families')}
            className="flex items-center space-x-1 py-1 px-1.5 hover:bg-[#f1f5f9] rounded cursor-pointer font-bold text-[#1e293b]"
          >
            {expandedSections.families ? <ChevronDown size={14} className="text-[#64748b]" /> : <ChevronRight size={14} className="text-[#64748b]" />}
            <span>Families &amp; IFC Types</span>
          </div>

          {expandedSections.families && (
            <div className="pl-4 space-y-1 mt-0.5 border-l border-[#e2e8f0] ml-2 text-[10px] text-[#475569]">
              {ifcClassEntries.length === 0 && (
                <div className="py-0.5 italic text-[#94a3b8]">No elements loaded</div>
              )}
              {ifcClassEntries.map(([ifcClass, count]) => (
                <div key={ifcClass} className="flex items-center space-x-1 py-0.5">
                  {classIcon(ifcClass)}
                  <span>
                    {ifcClass} ({count})
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Interactive Schedule / Quantities Modal */}
      <ScheduleModal
        isOpen={isScheduleOpen}
        onClose={() => setIsScheduleOpen(false)}
        initialCategory={scheduleCategory}
      />
    </div>
  );
};
