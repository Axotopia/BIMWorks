/**
 * Six-Region Viewport HUD Host
 * Adopted from N:\lapin\apps\viewer\src\components\viewport-ui\hud\ViewportHud.tsx
 *
 * Hosts screen-space viewport chrome across 6 non-overlapping regions.
 * Container is pointer-events-none; interactive child controls opt in with pointer-events-auto.
 */

import React from 'react';
import { HUD_REGIONS, REGION_CLASSNAMES, HudRegionName } from './hud-regions';
import { VisibilityChips } from './VisibilityChips';

export interface ViewportHudProps {
  topCenterSlot?: React.ReactNode;
  bottomLeftSlot?: React.ReactNode;
  bottomCenterSlot?: React.ReactNode;
  bottomRightSlot?: React.ReactNode;
}

export const ViewportHud: React.FC<ViewportHudProps> = ({
  topCenterSlot,
  bottomLeftSlot,
  bottomCenterSlot,
  bottomRightSlot,
}) => {
  return (
    <div
      className="pointer-events-none absolute inset-0 z-20 overflow-hidden select-none"
      data-testid="viewport-hud"
    >
      {HUD_REGIONS.map((region: HudRegionName) => {
        let content: React.ReactNode = null;
        if (region === 'top-left') {
          content = <VisibilityChips />;
        } else if (region === 'top-center') {
          content = topCenterSlot;
        } else if (region === 'bottom-left') {
          content = bottomLeftSlot;
        } else if (region === 'bottom-center') {
          content = bottomCenterSlot;
        } else if (region === 'bottom-right') {
          content = bottomRightSlot;
        }

        if (!content) return null;

        return (
          <div
            key={region}
            className={`absolute flex pointer-events-none ${REGION_CLASSNAMES[region]}`}
            data-region={region}
          >
            {content}
          </div>
        );
      })}
    </div>
  );
};
