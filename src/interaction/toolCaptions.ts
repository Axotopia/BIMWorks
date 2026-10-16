import { ActiveTool } from '../types/bim';

/**
 * Human captions for the armed tool.
 *
 * UI-P0-14: the status bar used to print the raw tool code — `Active Command: WA
 * — Click in viewport to place.` — which is both meaningless to a user and a lie
 * for the tools no viewport implemented. This is the single table; UI-P2 turns it
 * into the command registry's `getCaption`, and the ribbon reads the same entries
 * instead of carrying its own label strings.
 *
 * `implemented: false` marks a tool that currently has no viewport behaviour. The
 * ribbon uses that to stop advertising it and the status bar uses it to explain
 * the absence instead of claiming a placement is in progress.
 */
export interface ToolCaption {
  /** Short label as it should read in the ribbon and the status bar. */
  caption: string;
  /** Revit-style two-letter shortcut, or null when the tool has none bound. */
  shortcut: string | null;
  /** False when no viewport consumes this tool yet. */
  implemented: boolean;
}

export const TOOL_CAPTIONS: Record<ActiveTool, ToolCaption> = {
  select: { caption: 'Modify', shortcut: null, implemented: true },
  WA: { caption: 'Wall', shortcut: 'WA', implemented: true },
  DR: { caption: 'Door', shortcut: 'DR', implemented: true },
  WN: { caption: 'Window', shortcut: 'WN', implemented: true },
  SB: { caption: 'Floor', shortcut: 'SB', implemented: true },
  RF: { caption: 'Roof', shortcut: 'RF', implemented: true },
  AL: { caption: 'Align & Lock', shortcut: 'AL', implemented: true },
  EQ: { caption: 'Equalize', shortcut: 'EQ', implemented: true },
  TR: { caption: 'Trim / Extend to Corner', shortcut: 'TR', implemented: true },
  SL: { caption: 'Split Element', shortcut: 'SL', implemented: true },
  SO: { caption: 'Split with Gap', shortcut: 'SO', implemented: true },
  BX: { caption: 'Section Box', shortcut: 'BX', implemented: true },
  sketch: { caption: 'Sketch Mode', shortcut: null, implemented: true },
  // No viewport branch yet. They come back with the command registry (UI-P2) and
  // the Options Bar (UI-P3) rather than as buttons that arm a dead tool.
  GR: { caption: 'Grid', shortcut: 'GR', implemented: false },
  LL: { caption: 'Level', shortcut: 'LL', implemented: false },
  DI: { caption: 'Aligned Dimension', shortcut: 'DI', implemented: false },
  DL: { caption: 'Detail Line', shortcut: 'DL', implemented: false },
  TG: { caption: 'Tag', shortcut: 'TG', implemented: false },
  TX: { caption: 'Text', shortcut: 'TX', implemented: false },
  SEC: { caption: 'Section', shortcut: 'SEC', implemented: false },
  SHT: { caption: 'Sheet', shortcut: 'SHT', implemented: false },
};

export function toolCaption(tool: ActiveTool): string {
  return TOOL_CAPTIONS[tool]?.caption ?? String(tool);
}

export function isToolImplemented(tool: ActiveTool): boolean {
  return TOOL_CAPTIONS[tool]?.implemented ?? false;
}

/** The tool's own instruction line, in place of a generic "click to place". */
export function toolPrompt(tool: ActiveTool): string {
  switch (tool) {
    case 'WA':
      return 'Click the wall start point, then the end point. The tool stays armed — Esc to finish.';
    case 'DR':
      return 'Click a wall to place a door on it.';
    case 'WN':
      return 'Click a wall to place a window on it.';
    case 'AL':
      return 'Pick the reference element, then the element to align and lock.';
    case 'TR':
      return 'Pick the first element to keep, then pick the second element to form a corner.';
    case 'SL':
      return 'Click a wall at the cut location to split it into two segments.';
    case 'SO':
      return 'Click a wall to split with a 6" joint gap.';
    case 'select':
      return '';
    default:
      return isToolImplemented(tool)
        ? 'Click in the viewport to use this tool. Press Esc to exit.'
        : `${toolCaption(tool)} is not available yet.`;
  }
}
