import React, { useRef, useState, useEffect, useCallback } from 'react';
import {
  Download,
  Plus,
  FileSpreadsheet,
  Trash2,
  Layers3,
  RotateCw,
  Maximize2,
  ZoomIn,
  ZoomOut,
  MousePointer,
  Type,
  Ruler,
  ArrowUpRight,
  Minus,
  Layers as LayersIcon,
  Check,
  Copy,
  FileCode,
  Table,
  Sparkles,
} from 'lucide-react';
import { useBimStore } from '../../store/useBimStore';
import { SheetPaperSize, SheetAnnotation } from '../../types/bim';
import { PAPER_SIZES, getSheetDimensions, STANDARD_SCALES, getScaleLabel } from './paperSizes';
import {
  formatDimensionValue,
  mmToSvgPx,
  getLineTypeDashArray,
} from './annotationStyles';
import { LayersManagerModal } from './LayersManagerModal';
import { CADHatchDefs, getCadHatchDefsSvgString } from './cadHatches';
import { downloadSheetDxf } from './dxfExport';
import { RevisionTableModal } from './RevisionTableModal';
import { SheetScheduleModal } from './SheetScheduleModal';

export const SheetCanvas: React.FC = () => {
  const {
    sheets,
    activeSheetId,
    views,
    addViewportToSheet,
    removeViewportFromSheet,
    moveViewport,
    updateViewportScale,
    updateSheet,
    exportSheetPdf,
    exportBatchPdf,
    sliced2D,
    projectName,
    activeScale,
    georeference,
    draftingLayers,
    textStyles,
    dimensionStyles,
    activeAnnotationTool,
    activeLayerId,
    activeTextStyleId,
    activeDimensionStyleId,
    selectedAnnotationId,
    setActiveAnnotationTool,
    setActiveLayerId,
    setActiveTextStyleId,
    setActiveDimensionStyleId,
    setSelectedAnnotationId,
    addSheetAnnotation,
    updateSheetAnnotation,
    removeSheetAnnotation,
    duplicateSheet,
    dimAllViewport,
    setActiveViewId,
    elements,
    levels,
  } = useBimStore();

  const sheet = sheets.find((s) => s.id === activeSheetId) || sheets[0] || {
    id: 'sheet-default',
    sheetNumber: 'A101',
    sheetTitle: 'UNNAMED SHEET',
    paperSize: 'ARCH_D' as SheetPaperSize,
    orientation: 'landscape' as const,
    projectName: 'BIMWorks Project',
    date: '2026-10-15',
    drawnBy: 'BIMWorks Architect',
    isPlaceholder: false,
    viewports: [],
    annotations: [],
  };

  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  // In-place title block editing state
  const [editingField, setEditingField] = useState<'title' | 'number' | 'drawnBy' | null>(null);
  const [tempValue, setTempValue] = useState<string>('');

  // Title-block metadata
  const crsCode = (georeference?.projected_crs || '').split(' - ')[0] || 'Not georeferenced';
  const sheetDate = sheet.date || new Date().toISOString().slice(0, 10);

  // Dynamic Sheet dimensions based on paper size & orientation
  const { width: sheetWidth, height: sheetHeight } = getSheetDimensions(sheet.paperSize, sheet.orientation);

  // Pan & Zoom state
  const [viewTransform, setViewTransform] = useState<{ x: number; y: number; zoom: number }>({ x: 0, y: 0, zoom: 1 });
  const [isPanning, setIsPanning] = useState(false);
  const [panStart, setPanStart] = useState<{ x: number; y: number; startX: number; startY: number } | null>(null);

  // Viewport dragging state
  const [draggingVpId, setDraggingVpId] = useState<string | null>(null);
  const [dragStart, setDragStart] = useState<{ x: number; y: number; vpX: number; vpY: number } | null>(null);

  // Phase 2 & 3: Annotation Drafting & Productivity State
  const [isLayersModalOpen, setIsLayersModalOpen] = useState(false);
  const [isRevisionModalOpen, setIsRevisionModalOpen] = useState(false);
  const [isScheduleModalOpen, setIsScheduleModalOpen] = useState(false);
  const [useCadHatching, setUseCadHatching] = useState(false);
  const [draftingPoints, setDraftingPoints] = useState<[number, number][]>([]);
  const [mouseHoverPos, setMouseHoverPos] = useState<[number, number] | null>(null);
  const [editingAnnotationId, setEditingAnnotationId] = useState<string | null>(null);
  const [editingAnnotationText, setEditingAnnotationText] = useState<string>('');

  // Fit sheet to viewport screen
  const fitToScreen = useCallback(() => {
    if (!containerRef.current) return;
    const containerW = containerRef.current.clientWidth;
    const containerH = containerRef.current.clientHeight;
    const padding = 80;
    const availW = containerW - padding;
    const availH = containerH - padding - 80; // account for toolbars
    if (availW <= 0 || availH <= 0) return;
    const scale = Math.min(availW / sheetWidth, availH / sheetHeight);
    const zoom = Math.max(0.2, Math.min(scale, 1.5));
    const x = (containerW - sheetWidth * zoom) / 2;
    const y = (containerH - sheetHeight * zoom) / 2 + 35;
    setViewTransform({ x, y, zoom });
  }, [sheetWidth, sheetHeight]);

  // Auto-fit on mount or when sheet paper size / orientation changes
  useEffect(() => {
    fitToScreen();
  }, [sheet.id, sheet.paperSize, sheet.orientation, fitToScreen]);

  // Convert screen coordinates to sheet paper-space coordinates
  const getSheetCoords = (e: React.MouseEvent | React.PointerEvent): [number, number] | null => {
    if (!svgRef.current) return null;
    const rect = svgRef.current.getBoundingClientRect();
    const x = (e.clientX - rect.left) / viewTransform.zoom;
    const y = (e.clientY - rect.top) / viewTransform.zoom;
    return [Math.round(x), Math.round(y)];
  };

  // Handle Wheel Zoom (centered on mouse position)
  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    const zoomFactor = e.deltaY < 0 ? 1.1 : 0.9;
    setViewTransform((prev) => {
      const newZoom = Math.max(0.15, Math.min(prev.zoom * zoomFactor, 5.0));
      const newX = mouseX - (mouseX - prev.x) * (newZoom / prev.zoom);
      const newY = mouseY - (mouseY - prev.y) * (newZoom / prev.zoom);
      return { x: newX, y: newY, zoom: newZoom };
    });
  };

  // Keyboard shortcut listener (Escape to cancel drafting or deselect)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (draftingPoints.length > 0) {
          setDraftingPoints([]);
        } else if (selectedAnnotationId) {
          setSelectedAnnotationId(null);
        } else if (activeAnnotationTool !== 'select') {
          setActiveAnnotationTool('select');
        }
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedAnnotationId && !editingAnnotationId && !editingField) {
        removeSheetAnnotation(sheet.id, selectedAnnotationId);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [draftingPoints, selectedAnnotationId, editingAnnotationId, editingField, activeAnnotationTool, sheet.id, removeSheetAnnotation, setActiveAnnotationTool, setSelectedAnnotationId]);

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
        const dropX = (e.clientX - rect.left) / viewTransform.zoom - 200;
        const dropY = (e.clientY - rect.top) / viewTransform.zoom - 150;
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
    const { width: sWidth, height: sHeight } = getSheetDimensions(targetSheet.paperSize, targetSheet.orientation);
    const pName = projectName || targetSheet.projectName || 'BIMWorks Project';
    const sTitle = targetSheet.sheetTitle || 'UNNAMED SHEET';
    const sNum = targetSheet.sheetNumber || 'A101';
    const sDate = targetSheet.date || sheetDate;
    const sDrawn = targetSheet.drawnBy || 'BIMWorks Architect';

    const viewportsSvg = (targetSheet.viewports || []).map((vp, index) => {
      const viewDef = views.find((v) => v.id === vp.viewId);
      const viewName = viewDef?.name || 'Floor Plan: Level 1';
      const vpScale = vp.scaleFactor ?? 20;

      const slabsSvg = (sliced2D?.slabs || []).map((s) => `<path d="${s.d}" stroke="#cbd5e1" stroke-width="0.05" fill="#f8fafc" />`).join('');
      const cutsSvg = (sliced2D?.cut_paths || []).map((p) => `<path d="${p.d}" stroke="#0f172a" stroke-width="0.07" fill="${useCadHatching ? 'url(#hatch-ansi31)' : '#cbd5e1'}" />`).join('');
      const projsSvg = (sliced2D?.projection_paths || []).map((p) => `<path d="${p.d}" stroke="#334155" stroke-width="0.03" fill="none" />`).join('');
      const swingsSvg = (sliced2D?.swing_paths || []).map((p) => `<path d="${p.d}" stroke="#2563eb" stroke-width="0.025" fill="none" />`).join('');

      return `
        <g transform="translate(${vp.x}, ${vp.y})">
          <rect x="0" y="0" width="${vp.width}" height="${vp.height}" fill="#ffffff" stroke="#94a3b8" stroke-width="1" stroke-dasharray="4, 2" />
          <g transform="translate(180, 220) scale(${vpScale}, -${vpScale})">
            ${slabsSvg}
            ${cutsSvg}
            ${projsSvg}
            ${swingsSvg}
          </g>
          <g transform="translate(20, ${vp.height + 25})">
            <circle cx="12" cy="0" r="12" fill="#0f172a" />
            <text x="12" y="4" text-anchor="middle" fill="#ffffff" font-size="11" font-weight="bold">${index + 1}</text>
            <text x="32" y="-2" fill="#0f172a" font-size="12" font-weight="bold">${viewName}</text>
            <text x="32" y="11" fill="#64748b" font-size="9" font-family="JetBrains Mono, monospace">Scale: ${getScaleLabel(vpScale)}</text>
            <line x1="30" y1="18" x2="${vp.width - 40}" y2="18" stroke="#0f172a" stroke-width="1.2" />
          </g>
        </g>
      `;
    }).join('');

    // Phase 2: Vector Annotations Export
    const annotationsSvg = (targetSheet.annotations || []).map((anno) => {
      const layer = draftingLayers.find((l) => l.id === anno.layerId) || draftingLayers[0];
      if (layer && !layer.visible) return '';
      const strokeColor = layer?.colour || '#0f172a';
      const strokeW = mmToSvgPx(layer?.penWeight || 0.25);
      const strokeDash = getLineTypeDashArray(layer?.lineType || 'solid', layer?.penWeight || 0.25);

      if (anno.kind === 'line') {
        const p1 = anno.points[0] || [0, 0];
        const p2 = anno.points[1] || [100, 100];
        const dashAttr = strokeDash ? `stroke-dasharray="${strokeDash}"` : '';
        return `<line x1="${p1[0]}" y1="${p1[1]}" x2="${p2[0]}" y2="${p2[1]}" stroke="${strokeColor}" stroke-width="${strokeW}" ${dashAttr} />`;
      }
      if (anno.kind === 'text') {
        const p = anno.points[0] || [100, 100];
        const style = textStyles.find((s) => s.id === anno.styleId) || textStyles[0];
        const fontSize = Math.max(10, (style?.heightMm || 2.5) * 3.78);
        const weight = style?.bold ? 'bold' : 'normal';
        return `<text x="${p[0]}" y="${p[1]}" fill="${style?.colour || strokeColor}" font-family="${style?.font || 'sans-serif'}" font-size="${fontSize}" font-weight="${weight}">${anno.text || 'NOTE'}</text>`;
      }
      if (anno.kind === 'leader') {
        const p1 = anno.points[0] || [0, 0];
        const p2 = anno.points[1] || [50, 50];
        const p3 = anno.points[2] || [p2[0] + 30, p2[1]];
        const style = textStyles.find((s) => s.id === anno.styleId) || textStyles[0];
        const fontSize = Math.max(10, (style?.heightMm || 2.5) * 3.78);
        return `
          <polyline points="${p1[0]},${p1[1]} ${p2[0]},${p2[1]} ${p3[0]},${p3[1]}" fill="none" stroke="${strokeColor}" stroke-width="${strokeW}" marker-start="url(#marker-arrow)" />
          <text x="${p3[0] + 4}" y="${p3[1] - 3}" fill="${style?.colour || strokeColor}" font-size="${fontSize}">${anno.text || 'CALLOUT'}</text>
        `;
      }
      if (anno.kind === 'dimension') {
        const p1 = anno.points[0] || [0, 0];
        const p2 = anno.points[1] || [100, 0];
        const dimStyle = dimensionStyles.find((s) => s.id === anno.styleId) || dimensionStyles[0];
        const dist = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
        const dimText = formatDimensionValue(dist, dimStyle);
        const midX = (p1[0] + p2[0]) / 2;
        const midY = (p1[1] + p2[1]) / 2;
        return `
          <line x1="${p1[0]}" y1="${p1[1]}" x2="${p2[0]}" y2="${p2[1]}" stroke="${strokeColor}" stroke-width="${strokeW}" />
          <text x="${midX}" y="${midY - 4}" text-anchor="middle" fill="${strokeColor}" font-size="10" font-family="JetBrains Mono, monospace" font-weight="bold">${dimText}</text>
        `;
      }
      return '';
    }).join('');

    const sheetRevisions = targetSheet.revisions && targetSheet.revisions.length > 0
      ? targetSheet.revisions
      : [{ id: '1', sequence: 1, description: 'INITIAL BIM ISSUE', date: sDate }];

    const revRowsSvg = sheetRevisions.slice(0, 5).map((r, i) => `
      <rect x="0" y="${144 + i * 16}" width="226" height="16" fill="${i % 2 === 0 ? '#ffffff' : '#f8fafc'}" stroke="#cbd5e1" stroke-width="0.5" />
      <text x="10" y="${155 + i * 16}" fill="#0f172a" font-size="6.5">${r.sequence}</text>
      <text x="35" y="${155 + i * 16}" fill="#0f172a" font-size="6.5">${r.description}</text>
      <text x="175" y="${155 + i * 16}" fill="#0f172a" font-size="6.5">${r.date}</text>
    `).join('');

    return `<?xml version="1.0" encoding="UTF-8"?>
<svg viewBox="0 0 ${sWidth} ${sHeight}" width="${sWidth}" height="${sHeight}" xmlns="http://www.w3.org/2000/svg" font-family="sans-serif">
  <defs>
    <marker id="marker-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M 0 1.5 L 10 5 L 0 8.5 z" fill="#0f172a" />
    </marker>
    <marker id="marker-tick" viewBox="-5 -5 10 10" refX="0" refY="0" markerWidth="8" markerHeight="8" orient="auto">
      <line x1="-3" y1="3" x2="3" y2="-3" stroke="#2563eb" stroke-width="1.5" />
    </marker>
    ${getCadHatchDefsSvgString()}
  </defs>
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
      ${revRowsSvg}
    </g>
    <g transform="translate(0, ${sHeight - 148})">
      <rect x="0" y="0" width="256" height="100" fill="#0f172a" />
      <text x="128" y="24" text-anchor="middle" fill="#94a3b8" font-size="9" font-weight="bold">SHEET NUMBER</text>
      <text x="128" y="72" text-anchor="middle" fill="#ffffff" font-size="40" font-weight="900" font-family="JetBrains Mono, monospace">${sNum}</text>
    </g>
  </g>
  ${viewportsSvg}
  <g id="sheet-annotations-export">
    ${annotationsSvg}
  </g>
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

  // Viewport pointer down
  const handlePointerDownVp = (e: React.PointerEvent, vpId: string, currentX: number, currentY: number) => {
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    setDraggingVpId(vpId);
    setDragStart({ x: e.clientX, y: e.clientY, vpX: currentX, vpY: currentY });
  };

  // Canvas container pointer down for pan
  const handleContainerPointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('.viewport-element')) return;
    if ((e.target as HTMLElement).closest('.annotation-element')) return;

    // Pan with middle button or left button when tool is 'select'
    if (e.button === 1 || (e.button === 0 && activeAnnotationTool === 'select') || e.shiftKey) {
      setIsPanning(true);
      setPanStart({ x: e.clientX, y: e.clientY, startX: viewTransform.x, startY: viewTransform.y });
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    }
  };

  // Handle Sheet SVG Click for Annotation Placement
  const handleSheetSvgClick = (e: React.MouseEvent) => {
    if (activeAnnotationTool === 'select') {
      setSelectedAnnotationId(null);
      return;
    }

    const coords = getSheetCoords(e);
    if (!coords) return;

    if (activeAnnotationTool === 'text') {
      addSheetAnnotation(sheet.id, {
        kind: 'text',
        layerId: activeLayerId,
        points: [coords],
        text: 'NOTE',
        styleId: activeTextStyleId,
      });
      return;
    }

    if (activeAnnotationTool === 'line') {
      if (draftingPoints.length === 0) {
        setDraftingPoints([coords]);
      } else {
        addSheetAnnotation(sheet.id, {
          kind: 'line',
          layerId: activeLayerId,
          points: [draftingPoints[0], coords],
        });
        setDraftingPoints([]);
      }
      return;
    }

    if (activeAnnotationTool === 'dimension') {
      if (draftingPoints.length === 0) {
        setDraftingPoints([coords]);
      } else {
        addSheetAnnotation(sheet.id, {
          kind: 'dimension',
          layerId: activeLayerId,
          points: [draftingPoints[0], coords],
          styleId: activeDimensionStyleId,
        });
        setDraftingPoints([]);
      }
      return;
    }

    if (activeAnnotationTool === 'leader') {
      if (draftingPoints.length === 0) {
        setDraftingPoints([coords]);
      } else {
        const shoulder = [coords[0] + 35, coords[1]] as [number, number];
        addSheetAnnotation(sheet.id, {
          kind: 'leader',
          layerId: activeLayerId,
          points: [draftingPoints[0], coords, shoulder],
          text: 'CALLOUT',
          styleId: activeTextStyleId,
        });
        setDraftingPoints([]);
      }
      return;
    }
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    // Update mouse hover position in sheet coords for preview linework
    const coords = getSheetCoords(e);
    if (coords) setMouseHoverPos(coords);

    if (isPanning && panStart) {
      const dx = e.clientX - panStart.x;
      const dy = e.clientY - panStart.y;
      setViewTransform((prev) => ({
        ...prev,
        x: panStart.startX + dx,
        y: panStart.startY + dy,
      }));
      return;
    }

    if (draggingVpId && dragStart) {
      const dx = (e.clientX - dragStart.x) / viewTransform.zoom;
      const dy = (e.clientY - dragStart.y) / viewTransform.zoom;
      const newX = Math.max(30, Math.min(dragStart.vpX + dx, sheetWidth - 320));
      const newY = Math.max(30, Math.min(dragStart.vpY + dy, sheetHeight - 150));
      moveViewport(draggingVpId, newX, newY, sheet.id);
    }
  };

  const handlePointerUp = () => {
    if (isPanning) {
      setIsPanning(false);
      setPanStart(null);
    }
    if (draggingVpId) {
      setDraggingVpId(null);
      setDragStart(null);
    }
  };

  const selectedAnnotation = (sheet.annotations || []).find((a) => a.id === selectedAnnotationId);

  return (
    <div
      ref={containerRef}
      className="relative w-full h-full bg-[#18181b] overflow-hidden select-none"
      onWheel={handleWheel}
      onPointerDown={handleContainerPointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      style={{ cursor: isPanning ? 'grabbing' : activeAnnotationTool !== 'select' ? 'crosshair' : 'default' }}
    >
      {/* Top Floating Control Bar */}
      <div className="absolute top-4 left-6 right-6 flex items-center justify-between bg-[#27272a]/95 backdrop-blur px-4 py-2 rounded-lg border border-[#3f3f46] text-xs z-20 shadow-lg">
        <div className="flex items-center space-x-3 text-white">
          <FileSpreadsheet size={16} className="text-[#10b981]" />
          <span className="font-bold text-sm tracking-wide">
            {sheet.sheetNumber} — {sheet.sheetTitle}
          </span>

          {/* Paper Size Selector */}
          <select
            value={sheet.paperSize || 'ARCH_D'}
            onChange={(e) => updateSheet(sheet.id, { paperSize: e.target.value as SheetPaperSize })}
            className="bg-[#3f3f46] text-white text-[11px] px-2 py-1 rounded border border-[#52525b] outline-none cursor-pointer hover:border-[#71717a] transition-colors"
            title="Sheet Paper Size"
          >
            {Object.entries(PAPER_SIZES).map(([key, def]) => (
              <option key={key} value={key}>
                {def.name} ({def.description})
              </option>
            ))}
          </select>

          {/* Orientation Toggle Button */}
          <button
            onClick={() => updateSheet(sheet.id, { orientation: sheet.orientation === 'portrait' ? 'landscape' : 'portrait' })}
            className="flex items-center space-x-1.5 px-2.5 py-1 bg-[#3f3f46] hover:bg-[#52525b] text-white rounded text-[11px] border border-[#52525b] transition-colors"
            title="Toggle Landscape / Portrait"
          >
            <RotateCw size={12} />
            <span className="capitalize">{sheet.orientation || 'landscape'}</span>
          </button>
        </div>

        <div className="flex items-center space-x-2">
          {/* Zoom controls */}
          <div className="flex items-center bg-[#3f3f46] rounded px-1.5 py-0.5 space-x-1 text-[#a1a1aa] border border-[#52525b]">
            <button
              onClick={() => setViewTransform((prev) => ({ ...prev, zoom: Math.max(0.2, prev.zoom * 0.85) }))}
              className="p-1 hover:text-white rounded"
              title="Zoom Out"
            >
              <ZoomOut size={13} />
            </button>
            <span className="text-[11px] font-mono px-1.5 text-white font-medium">
              {Math.round(viewTransform.zoom * 100)}%
            </span>
            <button
              onClick={() => setViewTransform((prev) => ({ ...prev, zoom: Math.min(4.0, prev.zoom * 1.15) }))}
              className="p-1 hover:text-white rounded"
              title="Zoom In"
            >
              <ZoomIn size={13} />
            </button>
            <button
              onClick={fitToScreen}
              className="flex items-center space-x-1 px-2 py-0.5 hover:text-white hover:bg-[#52525b] rounded text-[11px] transition-colors"
              title="Fit Sheet to Window"
            >
              <Maximize2 size={12} />
              <span>Fit</span>
            </button>
          </div>

          <button
            onClick={() => {
              addViewportToSheet(sheet.id, 'view-level-1', 70, 100);
            }}
            className="flex items-center space-x-1 px-2.5 py-1.5 bg-[#3f3f46] hover:bg-[#52525b] text-white rounded text-xs transition-colors"
            title="Add Floor Plan Viewport to Sheet"
          >
            <Plus size={13} />
            <span>Add Viewport</span>
          </button>

          <button
            onClick={async () => {
              await duplicateSheet(sheet.id);
            }}
            className="flex items-center space-x-1 px-2.5 py-1.5 bg-[#3f3f46] hover:bg-[#52525b] text-white rounded text-xs transition-colors"
            title="Duplicate active sheet with viewports, annotations, and revisions"
          >
            <Copy size={13} />
            <span>Duplicate</span>
          </button>

          <button
            onClick={() => setIsScheduleModalOpen(true)}
            className="flex items-center space-x-1 px-2.5 py-1.5 bg-[#3f3f46] hover:bg-[#52525b] text-white rounded text-xs transition-colors"
            title="Door & Window Schedules"
          >
            <Table size={13} className="text-emerald-400" />
            <span>Schedules</span>
          </button>

          <button
            onClick={() => setUseCadHatching((v) => !v)}
            className={`flex items-center space-x-1 px-2.5 py-1.5 rounded text-xs border transition-colors ${
              useCadHatching
                ? 'bg-indigo-600/30 text-indigo-300 border-indigo-500 font-semibold'
                : 'bg-[#3f3f46] text-slate-300 border-[#52525b] hover:text-white'
            }`}
            title="Toggle Architectural CAD Hatch Patterns for Wall Cuts"
          >
            <Sparkles size={12} className={useCadHatching ? 'text-indigo-400' : 'text-slate-400'} />
            <span>Hatch: {useCadHatching ? 'ANSI31' : 'Solid'}</span>
          </button>

          <button
            onClick={() => {
              const svgStr = renderSheetSvgString(sheet);
              const blob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' });
              const filename = `${sheet.sheetNumber || 'A101'}_${(sheet.sheetTitle || 'Sheet').replace(/\s+/g, '_')}.svg`;
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = filename;
              document.body.appendChild(a);
              a.click();
              document.body.removeChild(a);
              URL.revokeObjectURL(url);
            }}
            className="flex items-center space-x-1 px-2.5 py-1.5 bg-[#3f3f46] hover:bg-[#52525b] text-white rounded text-xs transition-colors"
            title="Download clean standalone SVG with embedded CAD linework"
          >
            <Download size={13} />
            <span>SVG</span>
          </button>

          <button
            onClick={() => {
              downloadSheetDxf(sheet, views, sliced2D, draftingLayers, textStyles, dimensionStyles);
            }}
            className="flex items-center space-x-1.5 px-3 py-1.5 bg-[#4f46e5] hover:bg-[#4338ca] text-white font-semibold rounded text-xs shadow transition-all"
            title="Export standard AutoCAD R2000 ASCII DXF with layers, linework, and annotations"
          >
            <FileCode size={14} />
            <span>Export DXF</span>
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

      {/* Secondary Floating Bar: Sheet Annotation & Drafting Tools (Phase 2) */}
      <div className="absolute top-16 left-6 flex items-center space-x-2 bg-[#27272a]/95 backdrop-blur px-3 py-1.5 rounded-lg border border-[#3f3f46] text-xs z-20 shadow-lg">
        {/* Tool Selector Buttons */}
        <div className="flex items-center space-x-1 bg-[#18181b] p-0.5 rounded border border-[#3f3f46]">
          <button
            onClick={() => { setActiveAnnotationTool('select'); setDraftingPoints([]); }}
            className={`p-1.5 rounded transition-colors ${
              activeAnnotationTool === 'select' ? 'bg-[#0284c7] text-white shadow-xs' : 'text-slate-400 hover:text-white'
            }`}
            title="Select & Move Annotations (Esc)"
          >
            <MousePointer size={14} />
          </button>
          <button
            onClick={() => { setActiveAnnotationTool('text'); setDraftingPoints([]); }}
            className={`p-1.5 rounded transition-colors ${
              activeAnnotationTool === 'text' ? 'bg-[#0284c7] text-white shadow-xs' : 'text-slate-400 hover:text-white'
            }`}
            title="Text Note (TX) — Click to place"
          >
            <Type size={14} />
          </button>
          <button
            onClick={() => { setActiveAnnotationTool('dimension'); setDraftingPoints([]); }}
            className={`p-1.5 rounded transition-colors ${
              activeAnnotationTool === 'dimension' ? 'bg-[#0284c7] text-white shadow-xs' : 'text-slate-400 hover:text-white'
            }`}
            title="Aligned Dimension (DI) — Click 2 points"
          >
            <Ruler size={14} />
          </button>
          <button
            onClick={() => { setActiveAnnotationTool('leader'); setDraftingPoints([]); }}
            className={`p-1.5 rounded transition-colors ${
              activeAnnotationTool === 'leader' ? 'bg-[#0284c7] text-white shadow-xs' : 'text-slate-400 hover:text-white'
            }`}
            title="Leader Callout — Click target, then shoulder"
          >
            <ArrowUpRight size={14} />
          </button>
          <button
            onClick={() => { setActiveAnnotationTool('line'); setDraftingPoints([]); }}
            className={`p-1.5 rounded transition-colors ${
              activeAnnotationTool === 'line' ? 'bg-[#0284c7] text-white shadow-xs' : 'text-slate-400 hover:text-white'
            }`}
            title="Detail Line (DL) — Click start and end points"
          >
            <Minus size={14} />
          </button>
        </div>

        <div className="h-4 w-px bg-slate-700" />

        {/* Active Layer Selector */}
        <div className="flex items-center space-x-1.5">
          <span className="text-[11px] text-slate-400 font-medium">Layer:</span>
          <select
            value={activeLayerId}
            onChange={(e) => setActiveLayerId(e.target.value)}
            className="bg-[#18181b] text-slate-200 border border-[#3f3f46] rounded px-2 py-0.5 text-[11px] font-mono outline-none cursor-pointer hover:border-[#0284c7] transition-colors"
            title="Active Drafting Layer"
          >
            {draftingLayers.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </div>

        {/* Layers Manager Modal Launcher */}
        <button
          onClick={() => setIsLayersModalOpen(true)}
          className="flex items-center space-x-1 px-2.5 py-1 bg-[#3f3f46] hover:bg-[#52525b] text-slate-200 hover:text-white rounded text-[11px] border border-[#52525b] transition-colors"
          title="Drafting Layers & Styles Manager"
        >
          <LayersIcon size={12} className="text-[#38bdf8]" />
          <span>Layers...</span>
        </button>

        {/* Drafting Status Cue */}
        {draftingPoints.length > 0 && (
          <span className="text-[11px] text-amber-300 font-mono bg-amber-950/60 px-2 py-0.5 rounded border border-amber-800">
            Click 2nd point (Esc to cancel)
          </span>
        )}
      </div>

      {/* Selected Annotation Context Bar */}
      {selectedAnnotation && (
        <div className="absolute top-28 left-6 flex items-center space-x-2 bg-slate-900/95 backdrop-blur px-3 py-1.5 rounded-lg border border-[#0284c7] text-xs z-20 shadow-xl animate-in fade-in duration-150">
          <span className="font-semibold text-slate-300 capitalize">{selectedAnnotation.kind} Annotation:</span>

          {(selectedAnnotation.kind === 'text' || selectedAnnotation.kind === 'leader') && (
            <div className="flex items-center space-x-1">
              <input
                type="text"
                value={editingAnnotationText || selectedAnnotation.text || ''}
                onChange={(e) => setEditingAnnotationText(e.target.value)}
                onBlur={() => {
                  if (editingAnnotationText) {
                    updateSheetAnnotation(sheet.id, selectedAnnotation.id, { text: editingAnnotationText });
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && editingAnnotationText) {
                    updateSheetAnnotation(sheet.id, selectedAnnotation.id, { text: editingAnnotationText });
                  }
                }}
                placeholder="Annotation text"
                className="bg-slate-800 border border-slate-700 text-white px-2 py-0.5 rounded text-xs outline-none focus:border-[#38bdf8] font-mono"
              />
            </div>
          )}

          <select
            value={selectedAnnotation.layerId}
            onChange={(e) => updateSheetAnnotation(sheet.id, selectedAnnotation.id, { layerId: e.target.value })}
            className="bg-slate-800 border border-slate-700 text-slate-200 px-1.5 py-0.5 rounded text-[11px] font-mono outline-none"
            title="Change Layer"
          >
            {draftingLayers.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>

          <button
            onClick={() => removeSheetAnnotation(sheet.id, selectedAnnotation.id)}
            className="p-1 hover:bg-red-900/50 text-red-400 hover:text-red-300 rounded transition-colors"
            title="Delete Annotation (Del)"
          >
            <Trash2 size={13} />
          </button>
        </div>
      )}

      {/* Sheet Canvas Pan/Zoom Wrapper */}
      <div
        style={{
          transform: `translate(${viewTransform.x}px, ${viewTransform.y}px) scale(${viewTransform.zoom})`,
          transformOrigin: '0 0',
          transition: isPanning ? 'none' : 'transform 0.05s ease-out',
        }}
      >
        <div
          className="relative bg-white shadow-2xl border border-slate-300 rounded-sm"
          style={{ width: `${sheetWidth}px`, height: `${sheetHeight}px` }}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
          onClick={handleSheetSvgClick}
        >
          <svg
            ref={svgRef}
            viewBox={`0 0 ${sheetWidth} ${sheetHeight}`}
            width={sheetWidth}
            height={sheetHeight}
            className="w-full h-full block font-sans"
            xmlns="http://www.w3.org/2000/svg"
          >
            <defs>
              <CADHatchDefs />
              <marker
                id="marker-arrow"
                viewBox="0 0 10 10"
                refX="8"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M 0 1.5 L 10 5 L 0 8.5 z" fill="#0f172a" />
              </marker>
              <marker
                id="marker-tick"
                viewBox="-5 -5 10 10"
                refX="0"
                refY="0"
                markerWidth="8"
                markerHeight="8"
                orient="auto"
              >
                <line x1="-3" y1="3" x2="3" y2="-3" stroke="#2563eb" strokeWidth="1.5" />
              </marker>
              <marker
                id="marker-dot"
                viewBox="-5 -5 10 10"
                refX="0"
                refY="0"
                markerWidth="6"
                markerHeight="6"
              >
                <circle cx="0" cy="0" r="3" fill="#2563eb" />
              </marker>
            </defs>

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
                <g
                  className="cursor-pointer group"
                  onClick={() => setIsRevisionModalOpen(true)}
                >
                  <text
                    x="0"
                    y="122"
                    fill="#0f172a"
                    fontSize="8"
                    fontWeight="bold"
                    letterSpacing="0.5"
                    className="group-hover:fill-[#0284c7] transition-colors"
                  >
                    REVISIONS ✎
                  </text>
                  <rect x="0" y="128" width="226" height="16" fill="#f1f5f9" stroke="#cbd5e1" strokeWidth="0.5" />
                  <text x="6" y="139" fill="#475569" fontSize="6.5" fontWeight="bold">NO.</text>
                  <text x="35" y="139" fill="#475569" fontSize="6.5" fontWeight="bold">DESCRIPTION</text>
                  <text x="180" y="139" fill="#475569" fontSize="6.5" fontWeight="bold">DATE</text>
                  {(sheet.revisions && sheet.revisions.length > 0
                    ? sheet.revisions
                    : [{ id: '1', sequence: 1, description: 'INITIAL BIM ISSUE', date: sheetDate }]
                  ).slice(0, 5).map((rev, revIdx) => (
                    <g key={rev.id || revIdx} transform={`translate(0, ${revIdx * 16})`}>
                      <rect
                        x="0"
                        y="144"
                        width="226"
                        height="16"
                        fill={revIdx % 2 === 0 ? '#ffffff' : '#f8fafc'}
                        stroke="#cbd5e1"
                        strokeWidth="0.5"
                      />
                      <text x="10" y="155" fill="#0f172a" fontSize="6.5">{rev.sequence}</text>
                      <text x="35" y="155" fill="#0f172a" fontSize="6.5">{rev.description}</text>
                      <text x="175" y="155" fill="#0f172a" fontSize="6.5">{rev.date}</text>
                    </g>
                  ))}
                </g>
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
            {/* Moveable viewports with title bars, scale picker & delete */}
            {/* ========================================================= */}
            {sheet.viewports.map((vp, index) => {
              const viewDef = views.find((v) => v.id === vp.viewId);
              const viewName = viewDef?.name || 'Floor Plan: Level 1';
              const vpScale = vp.scaleFactor ?? 20;

              return (
                <g
                  key={vp.id}
                  transform={`translate(${vp.x}, ${vp.y})`}
                  className="group viewport-element"
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    if (vp.viewId) setActiveViewId(vp.viewId);
                  }}
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

                  {/* Viewport Action Bar on Hover (Scale Picker + DIMALL + Remove + Step-Into) */}
                  <foreignObject x={vp.width - 240} y={6} width="234" height="28" className="opacity-0 group-hover:opacity-100 transition-opacity">
                    <div className="flex items-center space-x-1.5 justify-end">
                      <span className="text-[9px] text-slate-400 font-sans italic select-none">
                        Double-click to open
                      </span>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          dimAllViewport(sheet.id, vp.id);
                        }}
                        onPointerDown={(e) => e.stopPropagation()}
                        title="One-Click Auto-Dimension Plan (DIMALL)"
                        className="h-6 px-1.5 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 rounded flex items-center gap-1 text-[10px] font-semibold shadow-xs cursor-pointer border border-indigo-200"
                      >
                        <Ruler size={11} />
                        <span>DIMALL</span>
                      </button>
                      <select
                        value={vpScale}
                        onChange={(e) => updateViewportScale(vp.id, Number(e.target.value), sheet.id)}
                        className="h-6 px-1.5 py-0 bg-white/95 text-[#0f172a] text-[10px] font-mono font-medium rounded border border-slate-300 shadow-xs outline-none cursor-pointer hover:border-[#0284c7]"
                        title="Viewport Scale"
                        onClick={(e) => e.stopPropagation()}
                        onPointerDown={(e) => e.stopPropagation()}
                      >
                        {STANDARD_SCALES.map((sc) => (
                          <option key={sc.scaleFactor} value={sc.scaleFactor}>
                            {sc.label}
                          </option>
                        ))}
                      </select>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          removeViewportFromSheet(vp.id, sheet.id);
                        }}
                        onPointerDown={(e) => e.stopPropagation()}
                        title="Remove Viewport from Sheet"
                        className="w-6 h-6 bg-red-100 hover:bg-red-200 text-red-600 rounded flex items-center justify-center shadow-xs cursor-pointer"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </foreignObject>

                  {/* Embedded 2D Vector Plan Linework */}
                  <g transform={`translate(180, 220) scale(${vpScale}, -${vpScale})`}>
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
                        fill={useCadHatching ? 'url(#hatch-ansi31)' : '#cbd5e1'}
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
                      Scale: {getScaleLabel(vpScale)}
                    </text>
                    <line x1="30" y1="18" x2={vp.width - 40} y2="18" stroke="#0f172a" strokeWidth="1.2" />
                  </g>
                </g>
              );
            })}

            {/* ========================================================= */}
            {/* SHEET-SPACE ANNOTATIONS LAYER (Phase 2)                   */}
            {/* Text, Leaders, Dimensions, Detail Lines                    */}
            {/* ========================================================= */}
            <g id="sheet-annotations">
              {(sheet.annotations || []).map((anno) => {
                const layer = draftingLayers.find((l) => l.id === anno.layerId) || draftingLayers[0];
                if (layer && !layer.visible) return null;

                const strokeColor = layer?.colour || '#0f172a';
                const strokeW = mmToSvgPx(layer?.penWeight || 0.25);
                const strokeDash = getLineTypeDashArray(layer?.lineType || 'solid', layer?.penWeight || 0.25);
                const isSelected = selectedAnnotationId === anno.id;

                if (anno.kind === 'line') {
                  const p1 = anno.points[0] || [0, 0];
                  const p2 = anno.points[1] || [100, 100];
                  return (
                    <g
                      key={anno.id}
                      className="cursor-pointer annotation-element"
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedAnnotationId(anno.id);
                      }}
                    >
                      {isSelected && (
                        <line
                          x1={p1[0]}
                          y1={p1[1]}
                          x2={p2[0]}
                          y2={p2[1]}
                          stroke="#38bdf8"
                          strokeWidth={strokeW + 6}
                          opacity={0.4}
                          strokeLinecap="round"
                        />
                      )}
                      <line
                        x1={p1[0]}
                        y1={p1[1]}
                        x2={p2[0]}
                        y2={p2[1]}
                        stroke={strokeColor}
                        strokeWidth={strokeW}
                        strokeDasharray={strokeDash}
                      />
                    </g>
                  );
                }

                if (anno.kind === 'text') {
                  const p = anno.points[0] || [100, 100];
                  const style = textStyles.find((s) => s.id === anno.styleId) || textStyles[0];
                  const fontSize = Math.max(10, (style?.heightMm || 2.5) * 3.78);
                  return (
                    <g
                      key={anno.id}
                      transform={`translate(${p[0]}, ${p[1]})`}
                      className="cursor-pointer annotation-element"
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedAnnotationId(anno.id);
                        setEditingAnnotationText(anno.text || '');
                      }}
                    >
                      {isSelected && (
                        <rect
                          x="-4"
                          y={-fontSize - 2}
                          width={Math.max(50, (anno.text?.length || 4) * (fontSize * 0.6) + 12)}
                          height={fontSize + 8}
                          fill="none"
                          stroke="#38bdf8"
                          strokeWidth="1.2"
                          strokeDasharray="3, 2"
                        />
                      )}
                      <text
                        x="0"
                        y="0"
                        fill={style?.colour || strokeColor}
                        fontFamily={style?.font || 'sans-serif'}
                        fontSize={fontSize}
                        fontWeight={style?.bold ? 'bold' : 'normal'}
                        fontStyle={style?.italic ? 'italic' : 'normal'}
                      >
                        {anno.text || 'NOTE'}
                      </text>
                    </g>
                  );
                }

                if (anno.kind === 'leader') {
                  const p1 = anno.points[0] || [0, 0];
                  const p2 = anno.points[1] || [50, 50];
                  const p3 = anno.points[2] || [p2[0] + 30, p2[1]];
                  const style = textStyles.find((s) => s.id === anno.styleId) || textStyles[0];
                  const fontSize = Math.max(10, (style?.heightMm || 2.5) * 3.78);
                  return (
                    <g
                      key={anno.id}
                      className="cursor-pointer annotation-element"
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedAnnotationId(anno.id);
                        setEditingAnnotationText(anno.text || '');
                      }}
                    >
                      {isSelected && (
                        <polyline
                          points={`${p1[0]},${p1[1]} ${p2[0]},${p2[1]} ${p3[0]},${p3[1]}`}
                          fill="none"
                          stroke="#38bdf8"
                          strokeWidth={strokeW + 6}
                          opacity={0.4}
                          strokeLinecap="round"
                        />
                      )}
                      <polyline
                        points={`${p1[0]},${p1[1]} ${p2[0]},${p2[1]} ${p3[0]},${p3[1]}`}
                        fill="none"
                        stroke={strokeColor}
                        strokeWidth={strokeW}
                        markerStart="url(#marker-arrow)"
                      />
                      <text
                        x={p3[0] + 4}
                        y={p3[1] - 3}
                        fill={style?.colour || strokeColor}
                        fontFamily={style?.font || 'sans-serif'}
                        fontSize={fontSize}
                        fontWeight={style?.bold ? 'bold' : 'normal'}
                      >
                        {anno.text || 'CALLOUT'}
                      </text>
                    </g>
                  );
                }

                if (anno.kind === 'dimension') {
                  const p1 = anno.points[0] || [0, 0];
                  const p2 = anno.points[1] || [100, 0];
                  const dimStyle = dimensionStyles.find((s) => s.id === anno.styleId) || dimensionStyles[0];
                  const dist = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
                  const dimText = formatDimensionValue(dist, dimStyle);
                  const midX = (p1[0] + p2[0]) / 2;
                  const midY = (p1[1] + p2[1]) / 2;

                  // Extension witness lines
                  const angle = Math.atan2(p2[1] - p1[1], p2[0] - p1[0]);
                  const perpAngle = angle + Math.PI / 2;
                  const witnessLen = 10;
                  const w1a = [p1[0] - Math.cos(perpAngle) * witnessLen, p1[1] - Math.sin(perpAngle) * witnessLen];
                  const w1b = [p1[0] + Math.cos(perpAngle) * witnessLen, p1[1] + Math.sin(perpAngle) * witnessLen];
                  const w2a = [p2[0] - Math.cos(perpAngle) * witnessLen, p2[1] - Math.sin(perpAngle) * witnessLen];
                  const w2b = [p2[0] + Math.cos(perpAngle) * witnessLen, p2[1] + Math.sin(perpAngle) * witnessLen];

                  return (
                    <g
                      key={anno.id}
                      className="cursor-pointer annotation-element"
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedAnnotationId(anno.id);
                      }}
                    >
                      {isSelected && (
                        <line
                          x1={p1[0]}
                          y1={p1[1]}
                          x2={p2[0]}
                          y2={p2[1]}
                          stroke="#38bdf8"
                          strokeWidth={strokeW + 6}
                          opacity={0.4}
                        />
                      )}
                      {/* Witness lines */}
                      <line x1={w1a[0]} y1={w1a[1]} x2={w1b[0]} y2={w1b[1]} stroke={strokeColor} strokeWidth={0.75} />
                      <line x1={w2a[0]} y1={w2a[1]} x2={w2b[0]} y2={w2b[1]} stroke={strokeColor} strokeWidth={0.75} />
                      {/* Main Dimension Line */}
                      <line
                        x1={p1[0]}
                        y1={p1[1]}
                        x2={p2[0]}
                        y2={p2[1]}
                        stroke={strokeColor}
                        strokeWidth={strokeW}
                        markerStart={dimStyle.arrowType === 'arrow' ? 'url(#marker-arrow)' : 'url(#marker-tick)'}
                        markerEnd={dimStyle.arrowType === 'arrow' ? 'url(#marker-arrow)' : 'url(#marker-tick)'}
                      />
                      {/* Dimension Text */}
                      <text
                        x={midX}
                        y={midY - 4}
                        textAnchor="middle"
                        fill={strokeColor}
                        fontSize="10"
                        fontFamily="JetBrains Mono, monospace"
                        fontWeight="bold"
                      >
                        {dimText}
                      </text>
                    </g>
                  );
                }

                return null;
              })}

              {/* Active Drafting Rubberband / Preview */}
              {draftingPoints.length > 0 && mouseHoverPos && (
                <g>
                  <line
                    x1={draftingPoints[0][0]}
                    y1={draftingPoints[0][1]}
                    x2={mouseHoverPos[0]}
                    y2={mouseHoverPos[1]}
                    stroke="#38bdf8"
                    strokeWidth="1.5"
                    strokeDasharray="4, 3"
                  />
                  <circle cx={draftingPoints[0][0]} cy={draftingPoints[0][1]} r="3" fill="#38bdf8" />
                  <circle cx={mouseHoverPos[0]} cy={mouseHoverPos[1]} r="3" fill="#38bdf8" />
                </g>
              )}
            </g>
          </svg>
        </div>
      </div>

      {/* Layers & Styles Manager Modal */}
      <LayersManagerModal
        isOpen={isLayersModalOpen}
        onClose={() => setIsLayersModalOpen(false)}
      />

      {/* Revision Table Modal */}
      <RevisionTableModal
        isOpen={isRevisionModalOpen}
        onClose={() => setIsRevisionModalOpen(false)}
        revisions={sheet.revisions || []}
        onSave={(updatedRevs) => updateSheet(sheet.id, { revisions: updatedRevs })}
        defaultDrawnBy={sheet.drawnBy}
      />

      {/* Component Schedule Modal */}
      <SheetScheduleModal
        isOpen={isScheduleModalOpen}
        onClose={() => setIsScheduleModalOpen(false)}
        elements={Object.values(elements)}
        levels={levels}
      />
    </div>
  );
};
