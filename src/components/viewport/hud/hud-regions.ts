/**
 * Six HUD regions layout configuration for 3D Viewport
 * Adopted from N:\lapin\apps\viewer\src\components\viewport-ui\hud\hud-regions.ts
 */

export type HudRegionName =
  | 'top-left'
  | 'top-center'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-center'
  | 'bottom-right';

export const HUD_REGIONS: HudRegionName[] = [
  'top-left',
  'top-center',
  'top-right',
  'bottom-left',
  'bottom-center',
  'bottom-right',
];

export const REGION_CLASSNAMES: Record<HudRegionName, string> = {
  'top-left': 'top-3 left-3 items-start flex-col gap-2',
  'top-center': 'top-3 left-1/2 -translate-x-1/2 items-center flex-col gap-2',
  'top-right': 'top-3 right-3 items-end flex-col gap-2 pt-28', // Reserve space for ViewCube
  'bottom-left': 'bottom-3 left-3 items-start flex-col gap-2',
  'bottom-center': 'bottom-3 left-1/2 -translate-x-1/2 items-center flex-row gap-2',
  'bottom-right': 'bottom-3 right-3 items-end flex-col gap-2',
};
