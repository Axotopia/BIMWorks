import React, { useRef, useState } from 'react';
import { Download, Move, Plus, FileSpreadsheet, Layers, Maximize } from 'lucide-react';
import { useBimStore } from '../../store/useBimStore';
import { SheetViewport } from '../../types/bim';

export const SheetCanvas: React.FC = () => {
  const {
    sheets,
    activeSheetId,
    views,
    addViewportToSheet,
    exportSheetPdf,
    sliced2D,
  } = useBimStore();

  const sheet = sheets.find((s) => s.id === activeSheetId) || sheets[0];
  const svgRef = useRef<SVGSVGElement>(null);

  // Sheet dimensions in points (ARCH D = 36" x 24" = 2592 x 1728 points / 1056 x 704 px)
  const sheetWidth = 1056;
  const sheetHeight = 704;

  const [draggingVpId, setDraggingVpId] = useState<string | null>(null);
  const [dragOffset, setDragOffset] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

  // Handle Drag & Drop of Views from Project Browser
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    try {
      const dataStr = e.dataTransfer.getData('text/plain');
      const data = JSON.parse(dataStr);
      if (data.type === 'view') {
        const rect = svgRef.current?.getBoundingClientRect();
        if (!rect) return;
        const dropX = e.clientX - rect.left - 200;
        const dropY = e.clientY - rect.top - 150;
        addViewportToSheet(sheet.id, data.viewId, Math.max(50, dropX), Math.max(50, dropY));
      }
    } catch (err) {
      console.warn('Drop error', err);
    }
  };

  // Compile and Export Vector PDF
  const handleExportPdf = () => {
    if (!svgRef.current) return;
    const serializer = new XMLSerializer();
    const svgStr = serializer.serializeToString(svgRef.current);
    exportSheetPdf(sheet.id, svgStr);
  };

  return (
    <div className="relative w-full h-full bg-[#18181b] flex flex-col overflow-auto select-none p-6 items-center justify-center">
      {/* Top Floating Control Bar */}
      <div className="absolute top-4 left-6 right-6 flex items-center justify-between bg-[#27272a]/90 backdrop-blur px-4 py-2 rounded-lg border border-[#3f3f46] text-xs z-10 shadow-lg">
        <div className="flex items-center space-x-3 text-white">
          <FileSpreadsheet size={16} className="text-[#10b981]" />
          <span className="font-bold text-sm tracking-wide">
            {sheet.sheetNumber} — {sheet.sheetTitle}
          </span>
          <span className="text-[#a1a1aa] text-[11px] bg-[#3f3f46] px-2 py-0.5 rounded">
            ARCH D (24" × 36")
          </span>
        </div>

        <div className="flex items-center space-x-3">
          <button
            onClick={() => {
              // Quick drop Level 1 Floor Plan if empty
              addViewportToSheet(sheet.id, 'view-level-1', 70, 100);
            }}
            className="flex items-center space-x-1 px-2.5 py-1.5 bg-[#3f3f46] hover:bg-[#52525b] text-white rounded text-xs transition-colors"
          >
            <Plus size={13} />
            <span>Add Floor Plan Viewport</span>
          </button>

          <button
            onClick={handleExportPdf}
            className="flex items-center space-x-1.5 px-3 py-1.5 bg-[#0284c7] hover:bg-[#0369a1] text-white font-semibold rounded text-xs shadow transition-all"
            title="Compile to 100% Vector PDF via PyMuPDF"
          >
            <Download size={14} />
            <span>Export Vector PDF</span>
          </button>
        </div>
      </div>

      {/* Sheet White Canvas */}
      <div
        className="relative bg-white shadow-2xl border border-slate-300 rounded-sm mt-10"
        style={{ width: `${sheetWidth}px`, height: `${sheetHeight}px` }}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        <svg
          ref={svgRef}
          viewBox={`0 0 ${sheetWidth} ${sheetHeight}`}
          width={sheetWidth}
          height={sheetHeight}
          className="w-full h-full block font-sans"
          xmlns="http://www.w3.org/2000/svg"
        >
          {/* Sheet Outer Border & Margin */}
          <rect
            x="20"
            y="20"
            width={sheetWidth - 40}
            height={sheetHeight - 40}
            fill="#ffffff"
            stroke="#0f172a"
            strokeWidth="2"
          />
          <rect
            x="24"
            y="24"
            width={sheetWidth - 48}
            height={sheetHeight - 48}
            fill="none"
            stroke="#64748b"
            strokeWidth="0.75"
          />

          {/* ========================================================= */}
          {/* TITLE BLOCK ENGINE: Standard Architectural Title Block    */}
          {/* Token Interpolation: {{ProjectName}}, {{SheetNumber}}, etc */}
          {/* ========================================================= */}
          <g id="title-block" transform={`translate(${sheetWidth - 280}, 24)`}>
            {/* Title Block Column */}
            <rect
              x="0"
              y="0"
              width="256"
              height={sheetHeight - 48}
              fill="#fafafa"
              stroke="#0f172a"
              strokeWidth="1.5"
            />

            {/* Logo & Firm Name */}
            <rect x="0" y="0" width="256" height="85" fill="#0f172a" />
            <text x="128" y="38" textAnchor="middle" fill="#ffffff" fontSize="18" fontWeight="bold">
              OPEN REVIT LT
            </text>
            <text x="128" y="58" textAnchor="middle" fill="#38bdf8" fontSize="10" letterSpacing="2">
              NATIVE IFC4 BIM STUDIO
            </text>

            {/* Project Metadata Section */}
            <g transform="translate(15, 115)">
              <text x="0" y="0" fill="#64748b" fontSize="8" fontWeight="bold" letterSpacing="1">
                PROJECT NAME
              </text>
              <text x="0" y="16" fill="#0f172a" fontSize="13" fontWeight="bold">
                {sheet.projectName}
              </text>

              <line x1="0" y1="30" x2="226" y2="30" stroke="#e2e8f0" strokeWidth="1" />

              <text x="0" y="48" fill="#64748b" fontSize="8" fontWeight="bold" letterSpacing="1">
                SHEET TITLE
              </text>
              <text x="0" y="66" fill="#0f172a" fontSize="14" fontWeight="bold">
                {sheet.sheetTitle}
              </text>

              <line x1="0" y1="80" x2="226" y2="80" stroke="#e2e8f0" strokeWidth="1" />

              <text x="0" y="98" fill="#64748b" fontSize="8" fontWeight="bold">
                DATE / DRAWN BY
              </text>
              <text x="0" y="114" fill="#0f172a" fontSize="11" fontFamily="JetBrains Mono, monospace">
                {sheet.date} | {sheet.drawnBy}
              </text>

              <line x1="0" y1="128" x2="226" y2="128" stroke="#e2e8f0" strokeWidth="1" />

              <text x="0" y="146" fill="#64748b" fontSize="8" fontWeight="bold">
                SCALE / GEOREFERENCE
              </text>
              <text x="0" y="162" fill="#0f172a" fontSize="11" fontFamily="JetBrains Mono, monospace">
                1/4" = 1'-0" (EPSG:2285)
              </text>
            </g>

            {/* Sheet Number Huge Callout Box at Bottom */}
            <g transform={`translate(0, ${sheetHeight - 148})`}>
              <rect x="0" y="0" width="256" height="100" fill="#0f172a" />
              <text x="128" y="28" textAnchor="middle" fill="#94a3b8" fontSize="10" fontWeight="bold">
                SHEET NUMBER
              </text>
              <text
                x="128"
                y="74"
                textAnchor="middle"
                fill="#ffffff"
                fontSize="42"
                fontWeight="900"
                fontFamily="JetBrains Mono, monospace"
              >
                {sheet.sheetNumber}
              </text>
            </g>
          </g>

          {/* ========================================================= */}
          {/* VIEWPORTS PLACEMENT ON SHEET                              */}
          {/* ========================================================= */}
          {sheet.viewports.map((vp, index) => {
            const viewDef = views.find((v) => v.id === vp.viewId);
            const viewName = viewDef?.name || 'Floor Plan: Level 1';

            return (
              <g
                key={vp.id}
                transform={`translate(${vp.x}, ${vp.y})`}
                className="cursor-move group"
              >
                {/* Viewport Crop Border */}
                <rect
                  x="0"
                  y="0"
                  width={vp.width}
                  height={vp.height}
                  fill="#ffffff"
                  stroke="#94a3b8"
                  strokeWidth="1"
                  strokeDasharray="4, 2"
                  className="group-hover:stroke-[#0284c7]"
                />

                {/* Embedded 2D Vector Plan Linework */}
                <g transform="translate(180, 220) scale(20, -20)">
                  {/* Slabs */}
                  {sliced2D?.slabs.map((slab) => (
                    <path
                      key={`s-slab-${slab.guid}`}
                      d={slab.d}
                      stroke="#cbd5e1"
                      strokeWidth="0.05"
                      fill="#f8fafc"
                    />
                  ))}

                  {/* Walls Cut */}
                  {sliced2D?.cut_paths.map((p, pIdx) => (
                    <path
                      key={`s-cut-${pIdx}`}
                      d={p.d}
                      stroke="#0f172a"
                      strokeWidth="0.07"
                      fill="#cbd5e1"
                    />
                  ))}

                  {/* Projections */}
                  {sliced2D?.projection_paths.map((p, pIdx) => (
                    <path
                      key={`s-proj-${pIdx}`}
                      d={p.d}
                      stroke="#334155"
                      strokeWidth="0.03"
                      fill="none"
                    />
                  ))}

                  {/* Swings */}
                  {sliced2D?.swing_paths.map((p, pIdx) => (
                    <path
                      key={`s-swing-${pIdx}`}
                      d={p.d}
                      stroke="#2563eb"
                      strokeWidth="0.025"
                      fill="none"
                    />
                  ))}
                </g>

                {/* ========================================================= */}
                {/* AUTOMATIC VIEW TITLE BAR BELOW VIEWPORT                   */}
                {/* Displays: View Name, Scale, Detail/Sheet Number Bubble    */}
                {/* ========================================================= */}
                <g transform={`translate(20, ${vp.height + 25})`}>
                  {/* Detail Bubble */}
                  <circle cx="12" cy="0" r="12" fill="#0f172a" />
                  <text
                    x="12"
                    y="4"
                    textAnchor="middle"
                    fill="#ffffff"
                    fontSize="11"
                    fontWeight="bold"
                  >
                    {index + 1}
                  </text>

                  {/* View Name & Scale Line */}
                  <text x="32" y="-2" fill="#0f172a" fontSize="12" fontWeight="bold">
                    {viewName}
                  </text>
                  <text x="32" y="11" fill="#64748b" fontSize="9" fontFamily="JetBrains Mono, monospace">
                    Scale: 1/4" = 1'-0"
                  </text>
                  <line x1="30" y1="18" x2={vp.width - 40} y2="18" stroke="#0f172a" strokeWidth="1.2" />
                </g>
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
};
