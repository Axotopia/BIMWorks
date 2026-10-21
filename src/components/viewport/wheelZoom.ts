/**
 * Wheel Zoom and Fine Modifier Tracker for 3D Viewport
 * Adopted from N:\lapin\apps\viewer\src\components\viewer\wheelZoom.ts
 *
 * Distinguishes physical Ctrl/Cmd key presses from trackpad pinch gestures,
 * applying FINE_ZOOM_STEP_FACTOR = 0.2 for precise, CAD-grade zoom increments.
 */

export const FINE_ZOOM_STEP_FACTOR = 0.2;

export interface FineZoomModifierTracker {
  isHeld(): boolean;
  dispose(): void;
}

/**
 * Creates a tracker that listens on window keydown, keyup, and blur in the capture phase.
 * Capture phase guarantees modifier detection even when children stop propagation.
 */
export function createFineZoomModifierTracker(
  target: Pick<Window, 'addEventListener' | 'removeEventListener'> = window
): FineZoomModifierTracker {
  let held = false;

  const onKey = (e: Event) => {
    const ke = e as KeyboardEvent;
    held = Boolean(ke.ctrlKey || ke.metaKey);
  };

  const onBlur = () => {
    held = false;
  };

  target.addEventListener('keydown', onKey, true);
  target.addEventListener('keyup', onKey, true);
  target.addEventListener('blur', onBlur, true);

  return {
    isHeld() {
      return held;
    },
    dispose() {
      target.removeEventListener('keydown', onKey, true);
      target.removeEventListener('keyup', onKey, true);
      target.removeEventListener('blur', onBlur, true);
    },
  };
}

/**
 * Calculates the new zoom factor given wheel delta and modifier state.
 * Standard notch moves ~15%; fine zoom moves ~3% per notch.
 */
export function computeZoomFactor(deltaY: number, isFine: boolean): number {
  const baseDelta = 0.15;
  const factor = isFine ? baseDelta * FINE_ZOOM_STEP_FACTOR : baseDelta;
  return deltaY > 0 ? 1 + factor : 1 - factor;
}
