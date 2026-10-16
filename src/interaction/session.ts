/**
 * session.ts — Single source of truth for direct manipulation & interaction sessions.
 *
 * Implements Track B Phase 1:
 * - State shape: { tool, phase: 'idle' | 'armed' | 'picking' | 'dragging', picks, hover, hoverGuid, snap, preview, value }
 * - Reducer with actions: begin, point, pointer_down, pointer_move, pointer_up, hover, snap, preview, value, commit, cancel
 * - Wobble tolerance: movements <= 5 px from pointer_down do not transition to 'dragging'.
 * - Esc mid-gesture discards in-progress picks, sends zero commands, and returns to 'armed'.
 */

import { ActiveTool } from '../types/bim';
import { SnapCandidate } from './snapEngine';

export type InteractionPhase = 'idle' | 'armed' | 'picking' | 'dragging';

export interface InteractionSessionState {
  tool: ActiveTool;
  phase: InteractionPhase;
  picks: Array<[number, number] | [number, number, number]>;
  hover: ([number, number] | [number, number, number]) | null;
  hoverGuid: string | null;
  snap: SnapCandidate | null;
  preview: any;
  value: number | string | null;
  dragOriginScreen: [number, number] | null;
}

export type InteractionAction =
  | { type: 'begin'; tool: ActiveTool }
  | { type: 'point'; point: [number, number] | [number, number, number] }
  | { type: 'pointer_down'; screenPoint: [number, number]; point?: [number, number] | [number, number, number] }
  | { type: 'pointer_move'; screenPoint: [number, number]; point?: [number, number] | [number, number, number] }
  | { type: 'pointer_up'; screenPoint?: [number, number] }
  | { type: 'hover'; point: ([number, number] | [number, number, number]) | null; guid?: string | null }
  | { type: 'snap'; snap: SnapCandidate | null }
  | { type: 'preview'; preview: any }
  | { type: 'value'; value: number | string | null }
  | { type: 'commit' }
  | { type: 'cancel' };

/** 5-pixel threshold to distinguish between stationary click/pick and a drag gesture. */
export const WOBBLE_THRESHOLD_PX = 5;

export function createInitialSession(tool: ActiveTool = 'select'): InteractionSessionState {
  return {
    tool,
    phase: tool === 'select' ? 'idle' : 'armed',
    picks: [],
    hover: null,
    hoverGuid: null,
    snap: null,
    preview: null,
    value: null,
    dragOriginScreen: null,
  };
}

export function interactionReducer(
  state: InteractionSessionState,
  action: InteractionAction
): InteractionSessionState {
  switch (action.type) {
    case 'begin': {
      const phase: InteractionPhase = action.tool === 'select' ? 'idle' : 'armed';
      return {
        ...state,
        tool: action.tool,
        phase,
        picks: [],
        hover: null,
        hoverGuid: null,
        snap: null,
        preview: null,
        value: null,
        dragOriginScreen: null,
      };
    }

    case 'point': {
      const picks = [...state.picks, action.point];
      return {
        ...state,
        picks,
        phase: 'picking',
      };
    }

    case 'pointer_down': {
      return {
        ...state,
        dragOriginScreen: [action.screenPoint[0], action.screenPoint[1]],
        hover: action.point !== undefined ? action.point : state.hover,
      };
    }

    case 'pointer_move': {
      let phase = state.phase;
      if (state.dragOriginScreen) {
        const dx = action.screenPoint[0] - state.dragOriginScreen[0];
        const dy = action.screenPoint[1] - state.dragOriginScreen[1];
        const dist = Math.hypot(dx, dy);
        if (dist > WOBBLE_THRESHOLD_PX) {
          phase = 'dragging';
        }
      }
      return {
        ...state,
        phase,
        hover: action.point !== undefined ? action.point : state.hover,
      };
    }

    case 'pointer_up': {
      return {
        ...state,
        dragOriginScreen: null,
        phase:
          state.phase === 'dragging'
            ? state.picks.length > 0
              ? 'picking'
              : state.tool === 'select'
              ? 'idle'
              : 'armed'
            : state.phase,
      };
    }

    case 'hover': {
      return {
        ...state,
        hover: action.point,
        hoverGuid: action.guid !== undefined ? action.guid : state.hoverGuid,
      };
    }

    case 'snap': {
      return {
        ...state,
        snap: action.snap,
      };
    }

    case 'preview': {
      return {
        ...state,
        preview: action.preview,
      };
    }

    case 'value': {
      return {
        ...state,
        value: action.value,
      };
    }

    case 'commit': {
      return {
        ...state,
        phase: state.tool === 'select' ? 'idle' : 'armed',
        picks: [],
        hover: null,
        hoverGuid: null,
        snap: null,
        preview: null,
        value: null,
        dragOriginScreen: null,
      };
    }

    case 'cancel': {
      return {
        ...state,
        phase: state.tool === 'select' ? 'idle' : 'armed',
        picks: [],
        hover: null,
        hoverGuid: null,
        snap: null,
        preview: null,
        value: null,
        dragOriginScreen: null,
      };
    }

    default:
      return state;
  }
}
