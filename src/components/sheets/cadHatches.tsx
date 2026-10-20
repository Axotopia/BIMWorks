import React from 'react';

export interface HatchDefinition {
  id: string;
  name: string;
  description: string;
}

export const CAD_HATCH_PATTERNS: HatchDefinition[] = [
  { id: 'hatch-ansi31', name: 'ANSI31 (Brick / Masonry)', description: 'Standard 45° diagonal hatching' },
  { id: 'hatch-ansi32', name: 'ANSI32 (Steel / Metal)', description: '45° crosshatch lines' },
  { id: 'hatch-concrete', name: 'Concrete', description: 'Aggregate stone triangles with stipple dots' },
  { id: 'hatch-cross', name: 'Grid / Mesh', description: 'Orthogonal 90° crosshatch' },
  { id: 'hatch-earth', name: 'Earth / Soil', description: 'Staggered 3-line soil layers' },
  { id: 'hatch-sand', name: 'Sand / Grout', description: 'Uniform dispersed stipple dots' },
  { id: 'hatch-wood', name: 'Wood Grain', description: 'Directional timber rings' },
  { id: 'hatch-insulation', name: 'Batt Insulation', description: 'Thermal loop curves' },
];

/**
 * Returns standalone SVG <pattern> elements as a string for inclusion in SVG / PDF exports.
 */
export const getCadHatchDefsSvgString = (): string => {
  return `
    <pattern id="hatch-ansi31" width="10" height="10" patternUnits="userSpaceOnUse" patternTransform="rotate(45 0 0)">
      <line x1="0" y1="0" x2="0" y2="10" stroke="#475569" stroke-width="0.8" />
    </pattern>

    <pattern id="hatch-ansi32" width="10" height="10" patternUnits="userSpaceOnUse" patternTransform="rotate(45 0 0)">
      <line x1="0" y1="0" x2="0" y2="10" stroke="#334155" stroke-width="0.75" />
      <line x1="0" y1="0" x2="10" y2="0" stroke="#334155" stroke-width="0.75" />
    </pattern>

    <pattern id="hatch-concrete" width="24" height="24" patternUnits="userSpaceOnUse">
      <polygon points="4,4 7,8 3,9" fill="none" stroke="#475569" stroke-width="0.7" />
      <polygon points="16,14 19,13 17,17" fill="none" stroke="#475569" stroke-width="0.7" />
      <circle cx="12" cy="6" r="0.6" fill="#64748b" />
      <circle cx="20" cy="4" r="0.6" fill="#64748b" />
      <circle cx="6" cy="18" r="0.6" fill="#64748b" />
      <circle cx="14" cy="20" r="0.6" fill="#64748b" />
      <circle cx="22" cy="22" r="0.6" fill="#64748b" />
      <circle cx="9" cy="12" r="0.6" fill="#64748b" />
    </pattern>

    <pattern id="hatch-cross" width="8" height="8" patternUnits="userSpaceOnUse">
      <line x1="0" y1="0" x2="8" y2="0" stroke="#64748b" stroke-width="0.6" />
      <line x1="0" y1="0" x2="0" y2="8" stroke="#64748b" stroke-width="0.6" />
    </pattern>

    <pattern id="hatch-earth" width="20" height="20" patternUnits="userSpaceOnUse">
      <line x1="2" y1="4" x2="8" y2="4" stroke="#475569" stroke-width="0.75" />
      <line x1="3" y1="7" x2="7" y2="7" stroke="#475569" stroke-width="0.75" />
      <line x1="4" y1="10" x2="6" y2="10" stroke="#475569" stroke-width="0.75" />

      <line x1="12" y1="14" x2="18" y2="14" stroke="#475569" stroke-width="0.75" />
      <line x1="13" y1="17" x2="17" y2="17" stroke="#475569" stroke-width="0.75" />
      <line x1="14" y1="20" x2="16" y2="20" stroke="#475569" stroke-width="0.75" />
    </pattern>

    <pattern id="hatch-sand" width="12" height="12" patternUnits="userSpaceOnUse">
      <circle cx="2" cy="2" r="0.5" fill="#64748b" />
      <circle cx="8" cy="4" r="0.5" fill="#64748b" />
      <circle cx="4" cy="8" r="0.5" fill="#64748b" />
      <circle cx="10" cy="10" r="0.5" fill="#64748b" />
      <circle cx="11" cy="2" r="0.5" fill="#64748b" />
    </pattern>

    <pattern id="hatch-wood" width="30" height="15" patternUnits="userSpaceOnUse">
      <path d="M0,3 Q15,0 30,3 M0,8 Q15,5 30,8 M0,13 Q15,10 30,13" fill="none" stroke="#64748b" stroke-width="0.6" />
    </pattern>

    <pattern id="hatch-insulation" width="16" height="24" patternUnits="userSpaceOnUse">
      <path d="M0,12 C4,6 12,6 16,12 C12,18 4,18 0,12 Z" fill="none" stroke="#2563eb" stroke-width="0.8" />
    </pattern>
  `;
};

/**
 * React Component rendering standard CAD hatch patterns into SVG <defs>.
 */
export const CADHatchDefs: React.FC = () => {
  return (
    <>
      <pattern id="hatch-ansi31" width="10" height="10" patternUnits="userSpaceOnUse" patternTransform="rotate(45 0 0)">
        <line x1="0" y1="0" x2="0" y2="10" stroke="#475569" strokeWidth="0.8" />
      </pattern>

      <pattern id="hatch-ansi32" width="10" height="10" patternUnits="userSpaceOnUse" patternTransform="rotate(45 0 0)">
        <line x1="0" y1="0" x2="0" y2="10" stroke="#334155" strokeWidth="0.75" />
        <line x1="0" y1="0" x2="10" y2="0" stroke="#334155" strokeWidth="0.75" />
      </pattern>

      <pattern id="hatch-concrete" width="24" height="24" patternUnits="userSpaceOnUse">
        <polygon points="4,4 7,8 3,9" fill="none" stroke="#475569" strokeWidth="0.7" />
        <polygon points="16,14 19,13 17,17" fill="none" stroke="#475569" strokeWidth="0.7" />
        <circle cx="12" cy="6" r="0.6" fill="#64748b" />
        <circle cx="20" cy="4" r="0.6" fill="#64748b" />
        <circle cx="6" cy="18" r="0.6" fill="#64748b" />
        <circle cx="14" cy="20" r="0.6" fill="#64748b" />
        <circle cx="22" cy="22" r="0.6" fill="#64748b" />
        <circle cx="9" cy="12" r="0.6" fill="#64748b" />
      </pattern>

      <pattern id="hatch-cross" width="8" height="8" patternUnits="userSpaceOnUse">
        <line x1="0" y1="0" x2="8" y2="0" stroke="#64748b" strokeWidth="0.6" />
        <line x1="0" y1="0" x2="0" y2="8" stroke="#64748b" strokeWidth="0.6" />
      </pattern>

      <pattern id="hatch-earth" width="20" height="20" patternUnits="userSpaceOnUse">
        <line x1="2" y1="4" x2="8" y2="4" stroke="#475569" strokeWidth="0.75" />
        <line x1="3" y1="7" x2="7" y2="7" stroke="#475569" strokeWidth="0.75" />
        <line x1="4" y1="10" x2="6" y2="10" stroke="#475569" strokeWidth="0.75" />
        <line x1="12" y1="14" x2="18" y2="14" stroke="#475569" strokeWidth="0.75" />
        <line x1="13" y1="17" x2="17" y2="17" stroke="#475569" strokeWidth="0.75" />
        <line x1="14" y1="20" x2="16" y2="20" stroke="#475569" strokeWidth="0.75" />
      </pattern>

      <pattern id="hatch-sand" width="12" height="12" patternUnits="userSpaceOnUse">
        <circle cx="2" cy="2" r="0.5" fill="#64748b" />
        <circle cx="8" cy="4" r="0.5" fill="#64748b" />
        <circle cx="4" cy="8" r="0.5" fill="#64748b" />
        <circle cx="10" cy="10" r="0.5" fill="#64748b" />
        <circle cx="11" cy="2" r="0.5" fill="#64748b" />
      </pattern>

      <pattern id="hatch-wood" width="30" height="15" patternUnits="userSpaceOnUse">
        <path d="M0,3 Q15,0 30,3 M0,8 Q15,5 30,8 M0,13 Q15,10 30,13" fill="none" stroke="#64748b" strokeWidth="0.6" />
      </pattern>

      <pattern id="hatch-insulation" width="16" height="24" patternUnits="userSpaceOnUse">
        <path d="M0,12 C4,6 12,6 16,12 C12,18 4,18 0,12 Z" fill="none" stroke="#2563eb" strokeWidth="0.8" />
      </pattern>
    </>
  );
};
