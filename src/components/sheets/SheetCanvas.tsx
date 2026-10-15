import React, { useRef, useState } from 'react';
import { Download, Move, Plus, FileSpreadsheet, Layers, Trash2, Edit2, Layers3 } from 'lucide-react';
import { useBimStore } from '../../store/useBimStore';
import { SheetViewport } from '../../types/bim';

export const SheetCanvas: React.FC = () => {
  const {
    sheets,
    activeSheetId,
    views,
    addViewportToSheet,
    removeViewportFromSheet,
    moveViewport,
    updateSheet,
    exportSheetPdf,
    exportBatchPdf,
    sliced2D,
    projectName,
    activeScale,
    georeference,
  } = useBimStore();

  const sheet = sheets.find((s) => s.id === activeSheetId) || sheets[0] || {
    id: 'sheet-default',
    sheetNumber: 'A101',
    sheetTitle: 'UNNAMED SHEET',
    paperSize: 'ARCH_D',
    projectName: 'BIMWorks Project',
    date: '2026-10-15',
    drawnBy: 'BIMWorks Architect',
    isPlaceholder: false,
    viewports: [],
  };

  const svgRef = useRef<SVGSVGElement>(null);

  // In-place editing state
  const [editingField, setEditingField] = useState<'title' | 'number' | 'drawnBy' | null>(null);
  const [tempValue, setTempValue] = useState<string>('');

  // Title-block metadata
  const crsCode = (georeference?.projected_crs || '').split(' - ')[0] || 'Not georeferenced';
  const sheetDate = sheet.date || new Date().toISOString().slice(0, 10);

  // Sheet dimensions in points (ARCH D = 36" x 24" = 2592 x 1728 points / 1056 x 704 px)
  const sheetWidth = 1056;
  const sheetHeight = 704;

  // Viewport dragging state
  const [draggingVpId, setDraggingVpId] = useState<string | null>(null);
  const [dragStart, setDragStart] = useState<{ x: number; y: number; vpX: number; vpY: number } | null>(null);

  // Drag & drop from project browser
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
        addViewportToSheet(sheet.id, data.viewId, Math.max(50, Math.min(dropX, sheetWidth - 350)), Math.max(50, Math.min(dropY, sheetHeight - 200)));
      }
    } catch (err) {
      console.warn('Drop error', err);
    }
  };

  // Compile and Export Single Sheet Vector PDF
  const handleExportPdf = () => {
    if (!svgRef.current) return;
    const serializer = new XMLSerializer();
    const svgStr = serializer.serializeToString(svgRef.current);
    exportSheetPdf(sheet.id, svgStr);
  };

  const renderSheetSvgString = (targetSheet: typeof sheet): string => {
    const sWidth = sheetWidth;
    const sHeight = sheetHeight;
    const pName = projectName || targetSheet.projectName || 'BIMWorks Project';
    const sTitle = targetSheet.sheetTitle || 'UNNAMED SHEET';
    const sNum = targetSheet.sheetNumber || 'A101';
    const sDate = targetSheet.date || sheetDate;
    const sDrawn = targetSheet.drawnBy || 'BIMWorks Architect';

    const viewportsSvg = (targetSheet.viewports || []).map((vp, index) => {
      const viewDef = views.find((v) => v.id === vp.viewId);
      const viewName = viewDef?.name || 'Floor Plan: Level 1';

      const slabsSvg = (sliced2D?.slabs || []).map((s) => `<path d="${s.d}" stroke="#cbd5e1" stroke-width="0.05" fill="#f8fafc" />`).join('');
      const cutsSvg = (sliced2D?.cut_paths || []).map((p) => `<path d="${p.d}" stroke="#0f172a" stroke-width="0.07" fill="#cbd5e1" />`).join('');
      const projsSvg = (sliced2D?.projection_paths || []).map((p) => `<path d="${p.d}" stroke="#334155" stroke-width="0.03" fill="none" />`).join('');
      const swingsSvg = (sliced2D?.swing_paths || []).map((p) => `<path d="${p.d}" stroke="#2563eb" stroke-width="0.025" fill="none" />`).join('');

      return `
        <g transform="translate(${vp.x}, ${vp.y})">
          <rect x="0" y="0" width="${vp.width}" height="${vp.height}" fill="#ffffff" stroke="#94a3b8" stroke-width="1" stroke-dasharray="4, 2" />
          <g transform="translate(180, 220) scale(20, -20)">
            ${slabsSvg}
            ${cutsSvg}
            ${projsSvg}
            ${swingsSvg}
          </g>
          <g transform="translate(20, ${vp.height + 25})">
            <circle cx="12" cy="0" r="12" fill="#0f172a" />
            <text x="12" y="4" text-anchor="middle" fill="#ffffff" font-size="11" font-weight="bold">${index + 1}</text>
            <text x="32" y="-2" fill="#0f172a" font-size="12" font-weight="bold">${viewName}</text>
            <text x="32" y="11" fill="#64748b" font-size="9" font-family="JetBrains Mono, monospace">Scale: 1/4" = 1'-0"</text>
            <line x1="30" y1="18" x2="${vp.width - 40}" y2="18" stroke="#0f172a" stroke-width="1.2" />
          </g>
        </g>
      `;
    }).join('');

    return `<?xml version="1.0" encoding="UTF-8"?>
<svg viewBox="0 0 ${sWidth} ${sHeight}" width="${sWidth}" height="${sHeight}" xmlns="http://www.w3.org/2000/svg" font-family="sans-serif">
  <rect x="20" y="20" width="${sWidth - 40}" height="${sHeight - 40}" fill="#ffffff" stroke="#0f172a" stroke-width="2" />
  <rect x="24" y="24" width="${sWidth - 48}" height="${sHeight - 48}" fill="none" stroke="#64748b" stroke-width="0.75" />
  <g id="title-block" transform="translate(${sWidth - 280}, 24)">
    <rect x="0" y="0" width="256" height="${sHeight - 48}" fill="#fafafa" stroke="#0f172a" stroke-width="1.5" />
    <rect x="0" y="0" width="256" height="85" fill="#0f172a" />
    <text x="128" y="38" text-anchor="middle" fill="#ffffff" font-size="20" font-weight="bold" letter-spacing="1">BIMWORKS</text>
    <text x="128" y="58" text-anchor="middle" fill="#38bdf8" font-size="10" letter-spacing="2">NATIVE IFC4 BIM STUDIO</text>
    <g transform="translate(15, 115)">
      <text x="0" y="0" fill="#64748b" font-size="8" font-weight="bold" letter-spacing="1">PROJECT NAME</text>
      <text x="0" y="16" fill="#0f172a" font-size="13" font-weight="bold">${pName}</text>
      <line x1="0" y1="30" x2="226" y2="30" stroke="#e2e8f0" stroke-width="1" />
      <text x="0" y="48" fill="#64748b" font-size="8" font-weight="bold" letter-spacing="1">SHEET TITLE</text>
      <text x="0" y="66" fill="#0f172a" font-size="14" font-weight="bold">${sTitle}</text>
      <line x1="0" y1="80" x2="226" y2="80" stroke="#e2e8f0" stroke-width="1" />
      <text x="0" y="98" fill="#64748b" font-size="8" font-weight="bold">DATE / DRAWN BY</text>
      <text x="0" y="114" fill="#0f172a" font-size="11" font-family="JetBrains Mono, monospace">${sDate} | ${sDrawn}</text>
      <line x1="0" y1="128" x2="226" y2="128" stroke="#e2e8f0" stroke-width="1" />
      <text x="0" y="146" fill="#64748b" font-size="8" font-weight="bold">SCALE / GEOREFERENCE</text>
      <text x="0" y="162" fill="#0f172a" font-size="11" font-family="JetBrains Mono, monospace">${activeScale} (${crsCode})</text>
    </g>
    <g transform="translate(15, 305)">
      <line x1="0" y1="0" x2="226" y2="0" stroke="#0f172a" stroke-width="1.5" />
      <text x="0" y="16" fill="#0f172a" font-size="8" font-weight="bold" letter-spacing="0.5">NOTICE &amp; LEGAL DISCLAIMER</text>
      <text x="0" y="30" fill="#b91c1c" font-size="6.5" font-weight="bold">DO NOT SCALE DRAWINGS</text>
      <text x="0" y="42" fill="#64748b" font-size="5.5">All dimensions and conditions must be verified on site</text>
      <text x="0" y="52" fill="#64748b" font-size="5.5">prior to ordering materials or commencing fabrication/work.</text>
      <line x1="0" y1="106" x2="226" y2="106" stroke="#e2e8f0" stroke-width="1" />
      <text x="0" y="122" fill="#0f172a" font-size="8" font-weight="bold" letter-spacing="0.5">REVISIONS</text>
      <rect x="0" y="128" width="226" height="16" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="0.5" />
      <text x="6" y="139" fill="#475569" font-size="6.5" font-weight="bold">NO.</text>
      <text x="35" y="139" fill="#475569" font-size="6.5" font-weight="bold">DESCRIPTION</text>
      <text x="180" y="139" fill="#475569" font-size="6.5" font-weight="bold">DATE</text>
      <rect x="0" y="144" width="226" height="16" fill="#ffffff" stroke="#cbd5e1" stroke-width="0.5" />
      <text x="10" y="155" fill="#0f172a" font-size="6.5">1</text>
      <text x="35" y="155" fill="#0f172a" font-size="6.5">INITIAL BIM ISSUE</text>
      <text x="175" y="155" fill="#0f172a" font-size="6.5">${sDate}</text>
    </g>
    <g transform="translate(0, ${sHeight - 148})">
      <rect x="0" y="0" width="256" height="100" fill="#0f172a" />
      <text x="128" y="24" text-anchor="middle" fill="#94a3b8" font-size="9" font-weight="bold">SHEET NUMBER</text>
      <text x="128" y="72" text-anchor="middle" fill="#ffffff" font-size="40" font-weight="900" font-family="JetBrains Mono, monospace">${sNum}</text>
    </g>
  </g>
  ${viewportsSvg}
</svg>`;
  };

  // Batch Export All Sheets
  const handleExportBatch = () => {
    const serializer = typeof XMLSerializer !== 'undefined' ? new XMLSerializer() : null;
    const currentSvgStr = (svgRef.current && serializer) ? serializer.serializeToString(svgRef.current) : null;
    const batchData = sheets.map((s) => ({
      sheetName: `${s.sheetNumber}_${s.sheetTitle}`,
      svgContent: (s.id === sheet.id && currentSvgStr) ? currentSvgStr : renderSheetSvgString(s),
    }));
    exportBatchPdf(batchData, `${projectName || 'Project'}_Drawing_Set`);
  };

  const startEdit = (field: 'title' | 'number' | 'drawnBy', initialVal: string) => {
    setEditingField(field);
    setTempValue(initialVal);
  };

  const commitEdit = async () => {
    if (!editingField || !sheet) return;
    const clean = tempValue.trim();
    if (editingField === 'title' && clean) {
      await updateSheet(sheet.id, { sheetTitle: clean });
    } else if (editingField === 'number' && clean) {
      await updateSheet(sheet.id, { sheetNumber: clean });
    } else if (editingField === 'drawnBy' && clean) {
      await updateSheet(sheet.id, { drawnBy: clean });
    }
    setEditingField(null);
  };

  const handlePointerDownVp = (e: React.PointerEvent, vpId: string, currentX: number, currentY: number) => {
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    setDraggingVpId(vpId);
    setDragStart({ x: e.clientX, y: e.clientY, vpX: currentX, vpY: currentY });
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!draggingVpId || !dragStart) return;
    const dx = e.clientX - dragStart.x;
    const dy = e.clientY - dragStart.y;
    const newX = Math.max(30, Math.min(dragStart.vpX + dx, sheetWidth - 320));
    const newY = Math.max(30, Math.min(dragStart.vpY + dy, sheetHeight - 150));
    moveViewport(draggingVpId, newX, newY, sheet.id);
  };

  const handlePointerUp = () => {
    setDraggingVpId(null);
    setDragStart(null);
  };

  return (
    <div
      className="relative w-full h-full bg-[#18181b] flex flex-col overflow-auto select-none p-6 items-center justify-center"
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
    >
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

        <div className="flex items-center space-x-2">
          <button
            onClick={() => {
              addViewportToSheet(sheet.id, 'view-level-1', 70, 100);
            }}
            className="flex items-center space-x-1 px-2.5 py-1.5 bg-[#3f3f46] hover:bg-[#52525b] text-white rounded text-xs transition-colors"
          >
            <Plus size={13} />
            <span>Add Viewport</span>
          </button>

          <button
            onClick={handleExportPdf}
            className="flex items-center space-x-1.5 px-3 py-1.5 bg-[#0284c7] hover:bg-[#0369a1] text-white font-semibold rounded text-xs shadow transition-all"
            title="Compile to 100% Vector PDF via PyMuPDF"
          >
            <Download size={14} />
            <span>Export Sheet PDF</span>
          </button>

          <button
            onClick={handleExportBatch}
            className="flex items-center space-x-1.5 px-3 py-1.5 bg-[#10b981] hover:bg-[#059669] text-white font-semibold rounded text-xs shadow transition-all"
            title="Export full drawing set as multipage vector PDF"
          >
            <Layers3 size={14} />
            <span>Export Batch PDF</span>
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
          {/* In-place editable content: SheetTitle, SheetNumber, etc.  */}
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
            <text x="128" y="38" textAnchor="middle" fill="#ffffff" fontSize="20" fontWeight="bold" letterSpacing="1">
              BIMWORKS
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
                {projectName || sheet.projectName}
              </text>

              <line x1="0" y1="30" x2="226" y2="30" stroke="#e2e8f0" strokeWidth="1" />

              <text x="0" y="48" fill="#64748b" fontSize="8" fontWeight="bold" letterSpacing="1">
                SHEET TITLE (click to edit)
              </text>
              {editingField === 'title' ? (
                <foreignObject x="0" y="50" width="226" height="26">
                  <input
                    type="text"
                    value={tempValue}
                    autoFocus
                    onChange={(e) => setTempValue(e.target.value)}
                    onBlur={commitEdit}
                    onKeyDown={(e) => e.key === 'Enter' && commitEdit()}
                    className="w-full h-full px-1.5 py-0.5 border border-[#0284c7] rounded bg-white text-xs font-bold text-[#0f172a] outline-none shadow-xs"
                  />
                </foreignObject>
              ) : (
                <text
                  x="0"
                  y="66"
                  fill="#0f172a"
                  fontSize="14"
                  fontWeight="bold"
                  className="cursor-pointer hover:fill-[#0284c7] transition-colors"
                  onClick={() => startEdit('title', sheet.sheetTitle)}
                >
                  {sheet.sheetTitle} ✎
                </text>
              )}

              <line x1="0" y1="80" x2="226" y2="80" stroke="#e2e8f0" strokeWidth="1" />

              <text x="0" y="98" fill="#64748b" fontSize="8" fontWeight="bold">
                DATE / DRAWN BY
              </text>
              {editingField === 'drawnBy' ? (
                <foreignObject x="0" y="100" width="226" height="24">
                  <input
                    type="text"
                    value={tempValue}
                    autoFocus
                    onChange={(e) => setTempValue(e.target.value)}
                    onBlur={commitEdit}
                    onKeyDown={(e) => e.key === 'Enter' && commitEdit()}
                    className="w-full h-full px-1.5 py-0.5 border border-[#0284c7] rounded bg-white text-xs font-mono outline-none shadow-xs"
                  />
                </foreignObject>
              ) : (
                <text
                  x="0"
                  y="114"
                  fill="#0f172a"
                  fontSize="11"
                  fontFamily="JetBrains Mono, monospace"
                  className="cursor-pointer hover:fill-[#0284c7]"
                  onClick={() => startEdit('drawnBy', sheet.drawnBy || 'BIMWorks Architect')}
                >
                  {sheetDate} | {sheet.drawnBy || 'BIMWorks Architect'} ✎
                </text>
              )}

              <line x1="0" y1="128" x2="226" y2="128" stroke="#e2e8f0" strokeWidth="1" />

              <text x="0" y="146" fill="#64748b" fontSize="8" fontWeight="bold">
                SCALE / GEOREFERENCE
              </text>
              <text x="0" y="162" fill="#0f172a" fontSize="11" fontFamily="JetBrains Mono, monospace">
                {activeScale} ({crsCode})
              </text>
            </g>

            {/* Architectural Legal Notice & Professional Disclaimer */}
            <g transform="translate(15, 305)">
              <line x1="0" y1="0" x2="226" y2="0" stroke="#0f172a" strokeWidth="1.5" />
              <text x="0" y="16" fill="#0f172a" fontSize="8" fontWeight="bold" letterSpacing="0.5">
                NOTICE &amp; LEGAL DISCLAIMER
              </text>
              <text x="0" y="30" fill="#b91c1c" fontSize="6.5" fontWeight="bold">
                DO NOT SCALE DRAWINGS
              </text>
              <text x="0" y="42" fill="#64748b" fontSize="5.5">
                All dimensions and conditions must be verified on site
              </text>
              <text x="0" y="52" fill="#64748b" fontSize="5.5">
                prior to ordering materials or commencing fabrication/work.
              </text>
              <text x="0" y="64" fill="#64748b" fontSize="5.5">
                Drawings and digital models are instruments of service
              </text>
              <text x="0" y="74" fill="#64748b" fontSize="5.5">
                and uncertified drafts. They do not constitute stamped
              </text>
              <text x="0" y="84" fill="#64748b" fontSize="5.5">
                architectural or engineering contract documents unless
              </text>
              <text x="0" y="94" fill="#64748b" fontSize="5.5">
                signed &amp; sealed by a registered design professional.
              </text>
              <line x1="0" y1="106" x2="226" y2="106" stroke="#e2e8f0" strokeWidth="1" />

              {/* Revisions Table */}
              <text x="0" y="122" fill="#0f172a" fontSize="8" fontWeight="bold" letterSpacing="0.5">
                REVISIONS
              </text>
              <rect x="0" y="128" width="226" height="16" fill="#f1f5f9" stroke="#cbd5e1" strokeWidth="0.5" />
              <text x="6" y="139" fill="#475569" fontSize="6.5" fontWeight="bold">NO.</text>
              <text x="35" y="139" fill="#475569" fontSize="6.5" fontWeight="bold">DESCRIPTION</text>
              <text x="180" y="139" fill="#475569" fontSize="6.5" fontWeight="bold">DATE</text>
              <rect x="0" y="144" width="226" height="16" fill="#ffffff" stroke="#cbd5e1" strokeWidth="0.5" />
              <text x="10" y="155" fill="#0f172a" fontSize="6.5">1</text>
              <text x="35" y="155" fill="#0f172a" fontSize="6.5">INITIAL BIM ISSUE</text>
              <text x="175" y="155" fill="#0f172a" fontSize="6.5">2026-10-15</text>
            </g>

            {/* Sheet Number Huge Callout Box at Bottom */}
            <g transform={`translate(0, ${sheetHeight - 148})`}>
              <rect x="0" y="0" width="256" height="100" fill="#0f172a" />
              <text x="128" y="24" textAnchor="middle" fill="#94a3b8" fontSize="9" fontWeight="bold">
                SHEET NUMBER (click to edit)
              </text>
              {editingField === 'number' ? (
                <foreignObject x="30" y="32" width="196" height="48">
                  <input
                    type="text"
                    value={tempValue}
                    autoFocus
                    onChange={(e) => setTempValue(e.target.value)}
                    onBlur={commitEdit}
                    onKeyDown={(e) => e.key === 'Enter' && commitEdit()}
                    className="w-full h-full text-center px-1 py-0.5 border border-[#38bdf8] rounded bg-[#1e293b] text-2xl font-mono font-bold text-white outline-none shadow-xs"
                  />
                </foreignObject>
              ) : (
                <text
                  x="128"
                  y="72"
                  textAnchor="middle"
                  fill="#ffffff"
                  fontSize="40"
                  fontWeight="900"
                  fontFamily="JetBrains Mono, monospace"
                  className="cursor-pointer hover:fill-[#38bdf8] transition-colors"
                  onClick={() => startEdit('number', sheet.sheetNumber)}
                >
                  {sheet.sheetNumber}
                </text>
              )}
            </g>
          </g>

          {/* ========================================================= */}
          {/* VIEWPORTS PLACEMENT ON SHEET                              */}
          {/* Moveable viewports with title bars & delete handle        */}
          {/* ========================================================= */}
          {sheet.viewports.map((vp, index) => {
            const viewDef = views.find((v) => v.id === vp.viewId);
            const viewName = viewDef?.name || 'Floor Plan: Level 1';

            return (
              <g
                key={vp.id}
                transform={`translate(${vp.x}, ${vp.y})`}
                className="group"
              >
                {/* Viewport Crop Border & Drag Handle */}
                <rect
                  x="0"
                  y="0"
                  width={vp.width}
                  height={vp.height}
                  fill="#ffffff"
                  stroke="#94a3b8"
                  strokeWidth="1"
                  strokeDasharray="4, 2"
                  className="group-hover:stroke-[#0284c7] cursor-move"
                  onPointerDown={(e) => handlePointerDownVp(e, vp.id, vp.x, vp.y)}
                />

                {/* Viewport Action Bar on Hover */}
                <foreignObject x={vp.width - 28} y={4} width="24" height="24" className="opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={() => removeViewportFromSheet(vp.id, sheet.id)}
                    title="Remove Viewport from Sheet"
                    className="w-6 h-6 bg-red-100 hover:bg-red-200 text-red-600 rounded flex items-center justify-center shadow-xs"
                  >
                    <Trash2 size={12} />
                  </button>
                </foreignObject>

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
                <g
                  transform={`translate(20, ${vp.height + 25})`}
                  className="cursor-move"
                  onPointerDown={(e) => handlePointerDownVp(e, vp.id, vp.x, vp.y)}
                >
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
