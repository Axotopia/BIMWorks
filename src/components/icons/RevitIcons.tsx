import React from 'react';

interface IconProps {
  size?: number;
  className?: string;
}

/**
 * Custom vector CAD icons for Revit architectural UI parity.
 * Handcrafted bespoke vector SVGs to avoid any copyright issues
 * while offering unmistakable CAD iconography.
 */

// 1. Modify / Cursor
export const IconModify: React.FC<IconProps> = ({ size = 20, className = '' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <path d="M4 3L11.5 21L14.5 14.5L21 11.5L4 3Z" fill="#e0f2fe" stroke="#0284c7" strokeWidth="1.8" strokeLinejoin="round" />
    <path d="M14 14L20 20" stroke="#0284c7" strokeWidth="1.8" strokeLinecap="round" />
  </svg>
);

// 2. Properties
export const IconProperties: React.FC<IconProps> = ({ size = 20, className = '' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <rect x="3" y="3" width="18" height="18" rx="2" fill="#ffffff" stroke="#0284c7" strokeWidth="1.6" />
    <rect x="5" y="5" width="14" height="5" fill="#38bdf8" />
    <line x1="6" y1="13" x2="18" y2="13" stroke="#64748b" strokeWidth="1.4" />
    <line x1="6" y1="17" x2="14" y2="17" stroke="#64748b" strokeWidth="1.4" />
    <circle cx="10" cy="13" r="1.5" fill="#0284c7" />
    <circle cx="15" cy="17" r="1.5" fill="#0284c7" />
  </svg>
);

// 3. Wall
export const IconWall: React.FC<IconProps> = ({ size = 20, className = '' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <path d="M3 18C3 12 7 8 13 8H21V14H13C9 14 7 16 7 18H3Z" fill="#bae6fd" stroke="#0284c7" strokeWidth="1.5" />
    <path d="M7 18V21H21V15H17" stroke="#475569" strokeWidth="1.4" />
    <line x1="13" y1="8" x2="13" y2="14" stroke="#0284c7" strokeWidth="1.2" strokeDasharray="2 2" />
  </svg>
);

// 4. Door
export const IconDoor: React.FC<IconProps> = ({ size = 20, className = '' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <rect x="4" y="3" width="16" height="18" rx="1" fill="#f8fafc" stroke="#475569" strokeWidth="1.5" />
    <path d="M4 3L16 6V21L4 18V3Z" fill="#fed7aa" stroke="#ea580c" strokeWidth="1.5" />
    <circle cx="13" cy="14" r="1" fill="#c2410c" />
    <path d="M4 21C10 21 16 19 16 15" stroke="#94a3b8" strokeWidth="1.2" strokeDasharray="2 2" />
  </svg>
);

// 5. Window
export const IconWindow: React.FC<IconProps> = ({ size = 20, className = '' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <rect x="3" y="3" width="18" height="18" rx="1" fill="#e0f2fe" stroke="#475569" strokeWidth="1.6" />
    <line x1="12" y1="3" x2="12" y2="21" stroke="#475569" strokeWidth="1.4" />
    <line x1="3" y1="12" x2="21" y2="12" stroke="#475569" strokeWidth="1.4" />
    <rect x="5" y="5" width="5" height="5" fill="#38bdf8" fillOpacity="0.4" />
    <rect x="14" y="5" width="5" height="5" fill="#38bdf8" fillOpacity="0.4" />
  </svg>
);

// 6. Component
export const IconComponent: React.FC<IconProps> = ({ size = 20, className = '' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <path d="M12 2L20 6.5V15.5L12 20L4 15.5V6.5L12 2Z" fill="#f1f5f9" stroke="#64748b" strokeWidth="1.5" />
    <path d="M12 2V20" stroke="#64748b" strokeWidth="1.2" />
    <path d="M4 6.5L12 11L20 6.5" stroke="#64748b" strokeWidth="1.2" />
    <rect x="13" y="11" width="5" height="6" fill="#a855f7" fillOpacity="0.5" stroke="#9333ea" strokeWidth="1" />
  </svg>
);

// 7. Column
export const IconColumn: React.FC<IconProps> = ({ size = 20, className = '' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <ellipse cx="12" cy="5" rx="5" ry="2.5" fill="#e2e8f0" stroke="#475569" strokeWidth="1.4" />
    <path d="M7 5V19C7 20.4 9.2 21.5 12 21.5C14.8 21.5 17 20.4 17 19V5" fill="#f8fafc" stroke="#475569" strokeWidth="1.4" />
    <ellipse cx="12" cy="19" rx="5" ry="2.5" fill="#cbd5e1" stroke="#475569" strokeWidth="1.4" />
  </svg>
);

// 8. Roof
export const IconRoof: React.FC<IconProps> = ({ size = 20, className = '' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <path d="M2 14L12 4L22 14H18V20H6V14H2Z" fill="#fce7f3" stroke="#db2777" strokeWidth="1.5" strokeLinejoin="round" />
    <path d="M12 4V20" stroke="#db2777" strokeWidth="1.2" strokeDasharray="2 2" />
  </svg>
);

// 9. Ceiling
export const IconCeiling: React.FC<IconProps> = ({ size = 20, className = '' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <polygon points="3,6 17,3 21,9 7,12" fill="#e0f2fe" stroke="#0284c7" strokeWidth="1.4" />
    <line x1="7.6" y1="5" x2="11.6" y2="11" stroke="#38bdf8" strokeWidth="1.2" />
    <line x1="12.3" y1="4" x2="16.3" y2="10" stroke="#38bdf8" strokeWidth="1.2" />
    <path d="M3 17H21" stroke="#64748b" strokeWidth="1.5" strokeDasharray="2 2" />
  </svg>
);

// 10. Floor
export const IconFloor: React.FC<IconProps> = ({ size = 20, className = '' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <polygon points="12,3 22,8 12,13 2,8" fill="#38bdf8" stroke="#0284c7" strokeWidth="1.4" />
    <polygon points="2,8 12,13 12,17 2,12" fill="#94a3b8" stroke="#475569" strokeWidth="1.2" />
    <polygon points="12,13 22,8 22,12 12,17" fill="#64748b" stroke="#475569" strokeWidth="1.2" />
    <polygon points="2,12 12,17 12,21 2,16" fill="#cbd5e1" stroke="#475569" strokeWidth="1.2" />
    <polygon points="12,17 22,12 22,16 12,21" fill="#94a3b8" stroke="#475569" strokeWidth="1.2" />
  </svg>
);

// 11. Curtain System
export const IconCurtainSystem: React.FC<IconProps> = ({ size = 20, className = '' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <path d="M3 4C8 6 16 2 21 4V20C16 18 8 22 3 20V4Z" fill="#e0f2fe" stroke="#0284c7" strokeWidth="1.5" />
    <line x1="9" y1="4.5" x2="9" y2="20.5" stroke="#0284c7" strokeWidth="1.2" />
    <line x1="15" y1="3.5" x2="15" y2="19.5" stroke="#0284c7" strokeWidth="1.2" />
    <line x1="3" y1="12" x2="21" y2="12" stroke="#0284c7" strokeWidth="1.2" />
  </svg>
);

// 12. Curtain Grid
export const IconCurtainGrid: React.FC<IconProps> = ({ size = 20, className = '' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <rect x="3" y="3" width="18" height="18" stroke="#0284c7" strokeWidth="1.5" fill="none" />
    <line x1="9" y1="3" x2="9" y2="21" stroke="#38bdf8" strokeWidth="1.4" strokeDasharray="3 2" />
    <line x1="15" y1="3" x2="15" y2="21" stroke="#38bdf8" strokeWidth="1.4" strokeDasharray="3 2" />
    <line x1="3" y1="12" x2="21" y2="12" stroke="#38bdf8" strokeWidth="1.4" strokeDasharray="3 2" />
  </svg>
);

// 13. Mullion
export const IconMullion: React.FC<IconProps> = ({ size = 20, className = '' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <rect x="3" y="3" width="18" height="18" stroke="#94a3b8" strokeWidth="1.2" fill="#f8fafc" />
    <rect x="9.5" y="2" width="5" height="20" fill="#0284c7" stroke="#0369a1" strokeWidth="1.2" />
    <rect x="2" y="9.5" width="20" height="5" fill="#0284c7" stroke="#0369a1" strokeWidth="1.2" />
  </svg>
);

// 14. Railing
export const IconRailing: React.FC<IconProps> = ({ size = 20, className = '' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <line x1="2" y1="6" x2="22" y2="6" stroke="#0284c7" strokeWidth="2" strokeLinecap="round" />
    <line x1="2" y1="19" x2="22" y2="19" stroke="#64748b" strokeWidth="2" strokeLinecap="round" />
    <line x1="5" y1="6" x2="5" y2="19" stroke="#0284c7" strokeWidth="1.6" />
    <line x1="9" y1="6" x2="9" y2="19" stroke="#64748b" strokeWidth="1.2" />
    <line x1="12" y1="6" x2="12" y2="19" stroke="#64748b" strokeWidth="1.2" />
    <line x1="15" y1="6" x2="15" y2="19" stroke="#64748b" strokeWidth="1.2" />
    <line x1="19" y1="6" x2="19" y2="19" stroke="#0284c7" strokeWidth="1.6" />
  </svg>
);

// 15. Ramp
export const IconRamp: React.FC<IconProps> = ({ size = 20, className = '' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <polygon points="3,19 21,7 21,19" fill="#e2e8f0" stroke="#475569" strokeWidth="1.5" />
    <path d="M5 16L19 7" stroke="#0284c7" strokeWidth="1.8" strokeLinecap="round" />
    <line x1="12" y1="13" x2="12" y2="19" stroke="#94a3b8" strokeWidth="1" />
  </svg>
);

// 16. Stair
export const IconStair: React.FC<IconProps> = ({ size = 20, className = '' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <path d="M3 20H8V15H13V10H18V5H21V20H3Z" fill="#e2e8f0" stroke="#475569" strokeWidth="1.4" strokeLinejoin="round" />
    <path d="M4 19L19 6" stroke="#0284c7" strokeWidth="1.6" strokeLinecap="round" />
    <polygon points="19,6 16,7 18,9" fill="#0284c7" />
  </svg>
);

// 17. Model Text
export const IconModelText: React.FC<IconProps> = ({ size = 20, className = '' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <text x="3" y="18" fontFamily="Arial, sans-serif" fontSize="18" fontWeight="bold" fill="#64748b">A</text>
    <text x="5" y="16" fontFamily="Arial, sans-serif" fontSize="18" fontWeight="bold" fill="#0284c7">A</text>
  </svg>
);

// 18. Model Line
export const IconModelLine: React.FC<IconProps> = ({ size = 20, className = '' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <path d="M4 19C10 19 14 5 20 5" stroke="#334155" strokeWidth="2" strokeLinecap="round" />
    <circle cx="4" cy="19" r="2" fill="#0284c7" />
    <circle cx="20" cy="5" r="2" fill="#0284c7" />
  </svg>
);

// 19. Model Group
export const IconModelGroup: React.FC<IconProps> = ({ size = 20, className = '' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <rect x="3" y="3" width="18" height="18" rx="2" stroke="#94a3b8" strokeWidth="1.2" strokeDasharray="2 2" fill="none" />
    <rect x="5" y="8" width="6" height="6" fill="#38bdf8" stroke="#0284c7" strokeWidth="1" />
    <circle cx="15" cy="11" r="3" fill="#fbbf24" stroke="#d97706" strokeWidth="1" />
  </svg>
);

// 20. Room
export const IconRoom: React.FC<IconProps> = ({ size = 20, className = '' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <rect x="3" y="3" width="18" height="18" fill="#f8fafc" stroke="#64748b" strokeWidth="1.4" />
    <line x1="3" y1="3" x2="21" y2="21" stroke="#cbd5e1" strokeWidth="1" />
    <line x1="21" y1="3" x2="3" y2="21" stroke="#cbd5e1" strokeWidth="1" />
    <rect x="7" y="8" width="10" height="8" rx="1" fill="#ffffff" stroke="#0284c7" strokeWidth="1.2" />
    <text x="12" y="14" textAnchor="middle" fontSize="6" fontWeight="bold" fill="#0284c7">1</text>
  </svg>
);

// 21. Room Separator
export const IconRoomSeparator: React.FC<IconProps> = ({ size = 20, className = '' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <line x1="3" y1="12" x2="21" y2="12" stroke="#0284c7" strokeWidth="2" strokeDasharray="4 2" />
    <circle cx="4" cy="12" r="2.5" fill="#0284c7" />
    <circle cx="20" cy="12" r="2.5" fill="#0284c7" />
  </svg>
);

// 22. Tag Room
export const IconTagRoom: React.FC<IconProps> = ({ size = 20, className = '' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <rect x="4" y="6" width="16" height="12" rx="2" fill="#e0f2fe" stroke="#0284c7" strokeWidth="1.5" />
    <text x="12" y="15" textAnchor="middle" fontSize="8" fontWeight="bold" fill="#0369a1">1</text>
  </svg>
);

// 23. Opening
export const IconOpening: React.FC<IconProps> = ({ size = 20, className = '' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <rect x="3" y="3" width="18" height="18" fill="#f1f5f9" stroke="#64748b" strokeWidth="1.4" />
    <rect x="8" y="7" width="8" height="10" fill="#ffffff" stroke="#0284c7" strokeWidth="1.5" />
    <line x1="8" y1="7" x2="16" y2="17" stroke="#ef4444" strokeWidth="1.2" />
    <line x1="16" y1="7" x2="8" y2="17" stroke="#ef4444" strokeWidth="1.2" />
  </svg>
);

// 24. Level
export const IconLevel: React.FC<IconProps> = ({ size = 20, className = '' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <circle cx="6" cy="12" r="4" fill="#ffffff" stroke="#0284c7" strokeWidth="1.5" />
    <path d="M6 8V16M2 12H10" stroke="#0284c7" strokeWidth="1.2" />
    <path d="M6 8A4 4 0 0 1 10 12H6Z" fill="#0284c7" />
    <path d="M6 12H2A4 4 0 0 0 6 16Z" fill="#0284c7" />
    <line x1="10" y1="12" x2="22" y2="12" stroke="#0284c7" strokeWidth="1.5" strokeDasharray="4 2" />
  </svg>
);

// 25. Grid
export const IconGrid: React.FC<IconProps> = ({ size = 20, className = '' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <circle cx="6" cy="6" r="4" fill="#ffffff" stroke="#64748b" strokeWidth="1.5" />
    <text x="6" y="8.5" textAnchor="middle" fontSize="6" fontWeight="bold" fill="#334155">1</text>
    <line x1="6" y1="10" x2="6" y2="22" stroke="#64748b" strokeWidth="1.4" strokeDasharray="3 2" />
    <line x1="10" y1="16" x2="22" y2="16" stroke="#64748b" strokeWidth="1.4" strokeDasharray="3 2" />
  </svg>
);

// 26. Work Plane Set / Show
export const IconWorkPlane: React.FC<IconProps> = ({ size = 20, className = '' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <polygon points="4,16 14,20 20,8 10,4" fill="#e0f2fe" stroke="#0284c7" strokeWidth="1.5" />
    <line x1="7" y1="10" x2="17" y2="14" stroke="#38bdf8" strokeWidth="1" />
    <line x1="12" y1="6" x2="16" y2="18" stroke="#38bdf8" strokeWidth="1" />
  </svg>
);

// 27. Manage Links
export const IconManageLinks: React.FC<IconProps> = ({ size = 20, className = '' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <path d="M9 15L15 9" stroke="#ea580c" strokeWidth="2" strokeLinecap="round" />
    <path d="M11 6L14 3C16 1 19 1 21 3C23 5 23 8 21 10L18 13" stroke="#ea580c" strokeWidth="1.8" strokeLinecap="round" />
    <path d="M13 18L10 21C8 23 5 23 3 21C1 19 1 16 3 14L6 11" stroke="#ea580c" strokeWidth="1.8" strokeLinecap="round" />
  </svg>
);

// 28. Link IFC
export const IconLinkIFC: React.FC<IconProps> = ({ size = 20, className = '' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <path d="M6 13L10 9C12 7 15 7 17 9" stroke="#0284c7" strokeWidth="1.8" strokeLinecap="round" />
    <path d="M18 11L14 15C12 17 9 17 7 15" stroke="#9333ea" strokeWidth="1.8" strokeLinecap="round" />
    <rect x="2" y="2" width="7" height="7" rx="1" fill="#38bdf8" stroke="#0284c7" strokeWidth="1.2" />
    <rect x="15" y="15" width="7" height="7" rx="1" fill="#c084fc" stroke="#9333ea" strokeWidth="1.2" />
  </svg>
);

// 29. Link CAD
export const IconLinkCAD: React.FC<IconProps> = ({ size = 20, className = '' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <rect x="4" y="3" width="16" height="18" rx="1" fill="#f8fafc" stroke="#475569" strokeWidth="1.5" />
    <text x="12" y="15" textAnchor="middle" fontSize="6" fontWeight="bold" fill="#0284c7">CAD</text>
    <path d="M17 5L19 3M19 7L21 5" stroke="#ea580c" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);

// 30. Link Topography
export const IconLinkTopo: React.FC<IconProps> = ({ size = 20, className = '' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <path d="M3 18C7 14 11 19 16 14C19 11 20 12 21 13V20H3V18Z" fill="#bbf7d0" stroke="#16a34a" strokeWidth="1.4" />
    <path d="M3 13C6 10 10 14 15 10C18 7 19 8 21 9" stroke="#15803d" strokeWidth="1.4" fill="none" />
  </svg>
);

// 31. Decal
export const IconDecal: React.FC<IconProps> = ({ size = 20, className = '' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <rect x="4" y="4" width="16" height="13" rx="1" fill="#e0f2fe" stroke="#0284c7" strokeWidth="1.4" />
    <circle cx="8" cy="8" r="1.5" fill="#f59e0b" />
    <polygon points="6,15 11,9 15,13 18,10 18,15" fill="#38bdf8" />
  </svg>
);

// 32. Link / Import PDF
export const IconDocPDF: React.FC<IconProps> = ({ size = 20, className = '' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <rect x="4" y="3" width="16" height="18" rx="1.5" fill="#ffffff" stroke="#dc2626" strokeWidth="1.5" />
    <text x="12" y="15" textAnchor="middle" fontSize="6" fontWeight="bold" fill="#dc2626">PDF</text>
  </svg>
);

// 33. Link / Import Image
export const IconDocImage: React.FC<IconProps> = ({ size = 20, className = '' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <rect x="3" y="4" width="18" height="16" rx="2" fill="#ffffff" stroke="#0284c7" strokeWidth="1.5" />
    <circle cx="8" cy="9" r="1.5" fill="#eab308" />
    <path d="M5 18L10 12L14 16L17 13L19 18H5Z" fill="#bae6fd" />
  </svg>
);

// 34. Import CAD
export const IconImportCAD: React.FC<IconProps> = ({ size = 20, className = '' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <rect x="6" y="5" width="15" height="16" rx="1" fill="#f8fafc" stroke="#475569" strokeWidth="1.4" />
    <text x="13.5" y="16" textAnchor="middle" fontSize="5" fontWeight="bold" fill="#334155">CAD</text>
    <path d="M2 3L8 9M8 9H3M8 9V4" stroke="#0284c7" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

// 35. Load Family
export const IconLoadFamily: React.FC<IconProps> = ({ size = 20, className = '' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <path d="M3 6C3 4.9 3.9 4 5 4H9L11 6H19C20.1 6 21 6.9 21 8V18C21 19.1 20.1 20 19 20H5C3.9 20 3 19.1 3 18V6Z" fill="#f8fafc" stroke="#475569" strokeWidth="1.4" />
    <path d="M12 9V16M12 16L9 13M12 16L15 13" stroke="#0284c7" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

// 36. Load Autodesk Family / Cloud
export const IconLoadCloud: React.FC<IconProps> = ({ size = 20, className = '' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <path d="M19.5 14C20.9 14 22 12.9 22 11.5C22 10.2 21 9.1 19.7 9C19.3 6.2 16.9 4 14 4C11.6 4 9.5 5.5 8.6 7.6C8.1 7.2 7.6 7 7 7C5.3 7 4 8.3 4 10C4 10.3 4.1 10.6 4.2 10.8C2.9 11.4 2 12.6 2 14C2 15.7 3.3 17 5 17H19.5" stroke="#38bdf8" strokeWidth="1.5" fill="#f0f9ff" />
    <path d="M12 12V19M12 19L9 16M12 19L15 16" stroke="#0284c7" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

// 37. Dimension Aligned
export const IconDimAligned: React.FC<IconProps> = ({ size = 20, className = '' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <line x1="3" y1="5" x2="3" y2="19" stroke="#0284c7" strokeWidth="1.6" />
    <line x1="21" y1="5" x2="21" y2="19" stroke="#0284c7" strokeWidth="1.6" />
    <line x1="3" y1="12" x2="21" y2="12" stroke="#0284c7" strokeWidth="1.5" />
    <line x1="5" y1="10" x2="1" y2="14" stroke="#0284c7" strokeWidth="1.8" strokeLinecap="round" />
    <line x1="23" y1="10" x2="19" y2="14" stroke="#0284c7" strokeWidth="1.8" strokeLinecap="round" />
  </svg>
);

// 38. Dimension Linear
export const IconDimLinear: React.FC<IconProps> = ({ size = 20, className = '' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <line x1="4" y1="7" x2="4" y2="17" stroke="#0284c7" strokeWidth="1.6" />
    <line x1="20" y1="7" x2="20" y2="17" stroke="#0284c7" strokeWidth="1.6" />
    <line x1="4" y1="12" x2="20" y2="12" stroke="#0284c7" strokeWidth="1.5" />
    <circle cx="4" cy="12" r="2" fill="#0284c7" />
    <circle cx="20" cy="12" r="2" fill="#0284c7" />
  </svg>
);

// 39. Dimension Angular
export const IconDimAngular: React.FC<IconProps> = ({ size = 20, className = '' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <line x1="4" y1="20" x2="20" y2="20" stroke="#475569" strokeWidth="1.6" />
    <line x1="4" y1="20" x2="18" y2="6" stroke="#475569" strokeWidth="1.6" />
    <path d="M12 20C12 17 14 13 17 11" stroke="#0284c7" strokeWidth="1.8" fill="none" />
  </svg>
);

// 40. Dimension Radial
export const IconDimRadial: React.FC<IconProps> = ({ size = 20, className = '' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <path d="M4 20A14 14 0 0 1 20 4" stroke="#475569" strokeWidth="1.6" fill="none" strokeDasharray="3 2" />
    <line x1="4" y1="20" x2="15" y2="9" stroke="#0284c7" strokeWidth="1.8" />
    <polygon points="15,9 12,10 14,12" fill="#0284c7" />
    <circle cx="4" cy="20" r="2" fill="#475569" />
  </svg>
);

// 41. Spot Elevation
export const IconSpotElevation: React.FC<IconProps> = ({ size = 20, className = '' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <circle cx="8" cy="14" r="5" fill="#ffffff" stroke="#0284c7" strokeWidth="1.5" />
    <path d="M8 9A5 5 0 0 1 13 14H8Z" fill="#0284c7" />
    <path d="M8 14H3A5 5 0 0 0 8 19Z" fill="#0284c7" />
    <path d="M13 14H21V10" stroke="#0284c7" strokeWidth="1.5" fill="none" />
  </svg>
);

// 42. Detail Line
export const IconDetailLine: React.FC<IconProps> = ({ size = 20, className = '' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <path d="M4 20C4 10 12 4 20 4" stroke="#334155" strokeWidth="1.8" strokeLinecap="round" />
    <rect x="3" y="18" width="4" height="4" fill="#0284c7" />
    <rect x="17" y="2" width="4" height="4" fill="#0284c7" />
  </svg>
);

// 43. Region (Hatch)
export const IconRegion: React.FC<IconProps> = ({ size = 20, className = '' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <rect x="4" y="4" width="16" height="16" fill="#f8fafc" stroke="#475569" strokeWidth="1.5" />
    <line x1="4" y1="10" x2="10" y2="4" stroke="#0284c7" strokeWidth="1.2" />
    <line x1="4" y1="16" x2="16" y2="4" stroke="#0284c7" strokeWidth="1.2" />
    <line x1="8" y1="20" x2="20" y2="8" stroke="#0284c7" strokeWidth="1.2" />
    <line x1="14" y1="20" x2="20" y2="14" stroke="#0284c7" strokeWidth="1.2" />
  </svg>
);

// 44. Revision Cloud
export const IconRevisionCloud: React.FC<IconProps> = ({ size = 20, className = '' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <path d="M6 16C4 16 3 14 4 12C2.5 11 3 9 4.5 8C4.5 6 6.5 5 8.5 6C10 4 13 4 14.5 6C16 5 18 6 18.5 8C20 9 20.5 11 19 12C20 14 19 16 17 16C16 17.5 14 17.5 13 16.5C11.5 18 9 18 8 16.5C7 17.5 6 17 6 16Z" fill="#f8fafc" stroke="#64748b" strokeWidth="1.5" />
  </svg>
);

// 45. Insulation
export const IconInsulation: React.FC<IconProps> = ({ size = 20, className = '' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <path d="M4 12C4 8 8 8 8 12C8 16 12 16 12 12C12 8 16 8 16 12C16 16 20 16 20 12" stroke="#eab308" strokeWidth="2.2" strokeLinecap="round" fill="none" />
  </svg>
);

// 46. Text
export const IconText: React.FC<IconProps> = ({ size = 20, className = '' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <text x="5" y="19" fontFamily="Arial, sans-serif" fontSize="20" fontWeight="bold" fill="#334155">A</text>
  </svg>
);

// 47. Check Spelling
export const IconCheckSpelling: React.FC<IconProps> = ({ size = 20, className = '' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <text x="2" y="15" fontFamily="Arial, sans-serif" fontSize="11" fontWeight="bold" fill="#475569">ABC</text>
    <path d="M14 16L17 19L22 13" stroke="#16a34a" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

// 48. Find / Replace
export const IconFindReplace: React.FC<IconProps> = ({ size = 20, className = '' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <circle cx="10" cy="10" r="7" stroke="#475569" strokeWidth="1.6" fill="#f8fafc" />
    <text x="10" y="14" textAnchor="middle" fontSize="10" fontWeight="bold" fill="#0284c7">A</text>
    <line x1="15" y1="15" x2="21" y2="21" stroke="#475569" strokeWidth="2" strokeLinecap="round" />
  </svg>
);

// 49. Tag By Category
export const IconTagCategory: React.FC<IconProps> = ({ size = 20, className = '' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <polygon points="12,3 20,7 20,17 12,21 4,17 4,7" fill="#ffffff" stroke="#475569" strokeWidth="1.4" />
    <text x="12" y="15" textAnchor="middle" fontSize="9" fontWeight="bold" fill="#334155">1</text>
  </svg>
);

// 50. Color Fill Legend
export const IconColorLegend: React.FC<IconProps> = ({ size = 20, className = '' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <rect x="4" y="4" width="4" height="4" fill="#ef4444" />
    <line x1="10" y1="6" x2="20" y2="6" stroke="#64748b" strokeWidth="1.5" />
    <rect x="4" y="10" width="4" height="4" fill="#3b82f6" />
    <line x1="10" y1="12" x2="20" y2="12" stroke="#64748b" strokeWidth="1.5" />
    <rect x="4" y="16" width="4" height="4" fill="#10b981" />
    <line x1="10" y1="18" x2="20" y2="18" stroke="#64748b" strokeWidth="1.5" />
  </svg>
);

// 51. Keynote
export const IconKeynote: React.FC<IconProps> = ({ size = 20, className = '' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <rect x="5" y="4" width="14" height="16" rx="1.5" fill="#ffffff" stroke="#475569" strokeWidth="1.5" />
    <text x="12" y="15" textAnchor="middle" fontSize="8" fontWeight="bold" fill="#0284c7">1</text>
  </svg>
);

// 52. Symbol
export const IconSymbol: React.FC<IconProps> = ({ size = 20, className = '' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <rect x="3" y="3" width="8" height="8" fill="#38bdf8" />
    <rect x="13" y="3" width="8" height="8" fill="#94a3b8" />
    <rect x="3" y="13" width="8" height="8" fill="#94a3b8" />
    <rect x="13" y="13" width="8" height="8" fill="#38bdf8" />
  </svg>
);

// 53. Stair Path
export const IconStairPath: React.FC<IconProps> = ({ size = 20, className = '' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <line x1="4" y1="6" x2="20" y2="6" stroke="#94a3b8" strokeWidth="1.2" />
    <line x1="4" y1="10" x2="20" y2="10" stroke="#94a3b8" strokeWidth="1.2" />
    <line x1="4" y1="14" x2="20" y2="14" stroke="#94a3b8" strokeWidth="1.2" />
    <line x1="4" y1="18" x2="20" y2="18" stroke="#94a3b8" strokeWidth="1.2" />
    <circle cx="12" cy="19" r="1.5" fill="#0284c7" />
    <line x1="12" y1="19" x2="12" y2="5" stroke="#0284c7" strokeWidth="1.8" />
    <polygon points="12,4 9,8 15,8" fill="#0284c7" />
  </svg>
);

// 54. Align (AL)
export const IconAlign: React.FC<IconProps> = ({ size = 20, className = '' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <line x1="12" y1="2" x2="12" y2="22" stroke="#0284c7" strokeWidth="2" strokeDasharray="3 2" />
    <rect x="3" y="4" width="7" height="6" fill="#38bdf8" stroke="#0284c7" strokeWidth="1.2" />
    <rect x="14" y="14" width="7" height="6" fill="#94a3b8" stroke="#475569" strokeWidth="1.2" />
    <path d="M19 11L14 11" stroke="#0284c7" strokeWidth="1.4" strokeLinecap="round" />
  </svg>
);

// 55. Offset (OF)
export const IconOffset: React.FC<IconProps> = ({ size = 20, className = '' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <path d="M4 18V8C4 5.8 5.8 4 8 4H16C18.2 4 20 5.8 20 8V18" stroke="#475569" strokeWidth="1.6" fill="none" strokeLinecap="round" />
    <path d="M8 18V9C8 7.9 8.9 7 10 7H14C15.1 7 16 7.9 16 9V18" stroke="#0284c7" strokeWidth="1.8" fill="none" strokeLinecap="round" />
  </svg>
);

// 56. Mirror Pick Axis (MM)
export const IconMirrorPick: React.FC<IconProps> = ({ size = 20, className = '' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <line x1="12" y1="2" x2="12" y2="22" stroke="#16a34a" strokeWidth="1.8" />
    <polygon points="10,6 4,18 10,18" fill="#e2e8f0" stroke="#475569" strokeWidth="1.2" />
    <polygon points="14,6 20,18 14,18" fill="#bae6fd" stroke="#0284c7" strokeWidth="1.2" />
    <path d="M13 11L17 15" stroke="#334155" strokeWidth="1.5" strokeLinecap="round" />
    <polygon points="13,11 13,15 15,13" fill="#334155" />
  </svg>
);

// 57. Mirror Draw Axis (DM)
export const IconMirrorDraw: React.FC<IconProps> = ({ size = 20, className = '' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <line x1="12" y1="2" x2="12" y2="22" stroke="#0284c7" strokeWidth="1.8" strokeDasharray="3 2" />
    <polygon points="10,6 4,18 10,18" fill="#e2e8f0" stroke="#475569" strokeWidth="1.2" />
    <polygon points="14,6 20,18 14,18" fill="#bae6fd" stroke="#0284c7" strokeWidth="1.2" />
    <path d="M12 4L15 2L17 4L14 6L12 4Z" fill="#f59e0b" stroke="#d97706" strokeWidth="0.8" />
  </svg>
);

// 58. Split Element (SL)
export const IconSplitElement: React.FC<IconProps> = ({ size = 20, className = '' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <rect x="3" y="9" width="8" height="6" fill="#e2e8f0" stroke="#475569" strokeWidth="1.2" />
    <rect x="13" y="9" width="8" height="6" fill="#e2e8f0" stroke="#475569" strokeWidth="1.2" />
    <line x1="12" y1="4" x2="12" y2="20" stroke="#ef4444" strokeWidth="2" strokeDasharray="2 2" />
    <polygon points="10,6 12,3 14,6" fill="#ef4444" />
    <polygon points="10,18 12,21 14,18" fill="#ef4444" />
  </svg>
);

// 59. Pin (PN)
export const IconPin: React.FC<IconProps> = ({ size = 20, className = '' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <path d="M9 3H15M12 3V9M7 9H17L15 15H9L7 9ZM12 15V22" stroke="#f59e0b" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

// 60. Unpin (UP)
export const IconUnpin: React.FC<IconProps> = ({ size = 20, className = '' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <path d="M8 3H14M11 3V8M6 8H16L14 14H8L6 8ZM11 14V21" stroke="#94a3b8" strokeWidth="1.6" strokeLinecap="round" />
    <line x1="17" y1="6" x2="22" y2="11" stroke="#ef4444" strokeWidth="2" strokeLinecap="round" />
    <line x1="22" y1="6" x2="17" y2="11" stroke="#ef4444" strokeWidth="2" strokeLinecap="round" />
  </svg>
);

// 61. Move (MV)
export const IconMove: React.FC<IconProps> = ({ size = 20, className = '' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <path d="M12 2L9 5H11V11H5V9L2 12L5 15V13H11V19H9L12 22L15 19H13V13H19V15L22 12L19 9V11H13V5H15L12 2Z" fill="#334155" />
  </svg>
);

// 62. Copy (CO)
export const IconCopyTool: React.FC<IconProps> = ({ size = 20, className = '' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <circle cx="7" cy="15" r="5" fill="#bae6fd" stroke="#0284c7" strokeWidth="1.4" />
    <circle cx="16" cy="9" r="5" fill="#f8fafc" stroke="#475569" strokeWidth="1.4" strokeDasharray="3 2" />
    <path d="M10 12L14 10" stroke="#0284c7" strokeWidth="1.6" strokeLinecap="round" />
    <polygon points="14,10 11,9 12,12" fill="#0284c7" />
  </svg>
);

// 63. Rotate (RO)
export const IconRotate: React.FC<IconProps> = ({ size = 20, className = '' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <circle cx="12" cy="12" r="2" fill="#334155" />
    <path d="M12 4C16.4 4 20 7.6 20 12C20 16.4 16.4 20 12 20C7.6 20 4 16.4 4 12" stroke="#475569" strokeWidth="1.6" fill="none" strokeDasharray="3 2" />
    <path d="M12 4V1M12 4L15 1" stroke="#334155" strokeWidth="1.8" strokeLinecap="round" />
  </svg>
);

// 64. Trim / Extend to Corner (TR)
export const IconTrimCorner: React.FC<IconProps> = ({ size = 20, className = '' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <path d="M4 19H14V9" stroke="#0284c7" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    <path d="M14 9H20" stroke="#94a3b8" strokeWidth="1.2" strokeDasharray="2 2" />
    <path d="M14 19V22" stroke="#94a3b8" strokeWidth="1.2" strokeDasharray="2 2" />
    <path d="M17 6L14 9M11 16L14 19" stroke="#0284c7" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);

// 65. Trim / Extend Single Element
export const IconTrimSingle: React.FC<IconProps> = ({ size = 20, className = '' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <line x1="16" y1="3" x2="16" y2="21" stroke="#0284c7" strokeWidth="2" />
    <line x1="4" y1="12" x2="16" y2="12" stroke="#334155" strokeWidth="2" strokeLinecap="round" />
    <polygon points="12,9 16,12 12,15" fill="#334155" />
  </svg>
);

// 66. Trim / Extend Multiple Elements
export const IconTrimMultiple: React.FC<IconProps> = ({ size = 20, className = '' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <line x1="18" y1="3" x2="18" y2="21" stroke="#0284c7" strokeWidth="2" />
    <line x1="4" y1="8" x2="18" y2="8" stroke="#334155" strokeWidth="1.8" strokeLinecap="round" />
    <line x1="4" y1="16" x2="18" y2="16" stroke="#334155" strokeWidth="1.8" strokeLinecap="round" />
    <polygon points="14,6 18,8 14,10" fill="#334155" />
    <polygon points="14,14 18,16 14,18" fill="#334155" />
  </svg>
);

// 67. Delete (DE)
export const IconDeleteRed: React.FC<IconProps> = ({ size = 20, className = '' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <line x1="4" y1="4" x2="20" y2="20" stroke="#dc2626" strokeWidth="3" strokeLinecap="round" />
    <line x1="20" y1="4" x2="4" y2="20" stroke="#dc2626" strokeWidth="3" strokeLinecap="round" />
  </svg>
);

// 68. Measure
export const IconMeasure: React.FC<IconProps> = ({ size = 20, className = '' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <rect x="3" y="10" width="18" height="6" fill="#f59e0b" stroke="#d97706" strokeWidth="1.2" rx="1" />
    <line x1="6" y1="10" x2="6" y2="13" stroke="#ffffff" strokeWidth="1" />
    <line x1="9" y1="10" x2="9" y2="12" stroke="#ffffff" strokeWidth="1" />
    <line x1="12" y1="10" x2="12" y2="13" stroke="#ffffff" strokeWidth="1" />
    <line x1="15" y1="10" x2="15" y2="12" stroke="#ffffff" strokeWidth="1" />
    <line x1="18" y1="10" x2="18" y2="13" stroke="#ffffff" strokeWidth="1" />
    <line x1="3" y1="5" x2="21" y2="5" stroke="#0284c7" strokeWidth="1.4" />
    <line x1="3" y1="3" x2="3" y2="7" stroke="#0284c7" strokeWidth="1.4" />
    <line x1="21" y1="3" x2="21" y2="7" stroke="#0284c7" strokeWidth="1.4" />
  </svg>
);

// 69. Create Similar (CS)
export const IconCreateSimilar: React.FC<IconProps> = ({ size = 20, className = '' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <rect x="2" y="5" width="10" height="10" fill="#38bdf8" stroke="#0284c7" strokeWidth="1.4" />
    <rect x="8" y="11" width="12" height="10" fill="#f1f5f9" stroke="#475569" strokeWidth="1.4" />
  </svg>
);

// 70. Create Group (GP)
export const IconCreateGroup: React.FC<IconProps> = ({ size = 20, className = '' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <rect x="3" y="3" width="18" height="18" rx="2" stroke="#475569" strokeWidth="1.2" strokeDasharray="3 2" fill="none" />
    <polygon points="12,5 14,9 18,10 15,13 16,17 12,15 8,17 9,13 6,10 10,9" fill="#f59e0b" stroke="#d97706" strokeWidth="0.8" />
  </svg>
);

// 71. 3D House (Thumbnail for 3D View)
export const IconHouse3D: React.FC<IconProps> = ({ size = 20, className = '' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <polygon points="12,3 21,9 18,9 18,20 6,20 6,9 3,9" fill="#f8fafc" stroke="#475569" strokeWidth="1.5" strokeLinejoin="round" />
    <rect x="10" y="13" width="4" height="7" fill="#cbd5e1" stroke="#475569" strokeWidth="1" />
    <polygon points="12,3 21,9 18,9 12,5 6,9 3,9" fill="#cbd5e1" />
  </svg>
);

// 72. Edit Type Icon
export const IconEditType: React.FC<IconProps> = ({ size = 14, className = '' }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <rect x="2" y="2" width="8" height="8" stroke="#475569" strokeWidth="1.2" fill="#f1f5f9" />
    <rect x="6" y="6" width="8" height="8" stroke="#0284c7" strokeWidth="1.2" fill="#e0f2fe" />
    <line x1="8" y1="10" x2="12" y2="10" stroke="#0284c7" strokeWidth="1" />
  </svg>
);

// 73. Materials (Checkerboard Sphere)
export const IconMaterials: React.FC<IconProps> = ({ size = 20, className = '' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <circle cx="12" cy="12" r="9" stroke="#475569" strokeWidth="1.6" fill="#f8fafc" />
    <path d="M12 3C7 3 3 7 3 12C3 17 7 21 12 21" fill="#94a3b8" />
    <path d="M12 3V21M3 12H21" stroke="#475569" strokeWidth="1.2" />
    <path d="M7 6L17 18M7 18L17 6" stroke="#475569" strokeWidth="0.8" strokeDasharray="1 1" />
  </svg>
);

// 74. Object Styles
export const IconObjectStyles: React.FC<IconProps> = ({ size = 20, className = '' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <rect x="3" y="3" width="10" height="10" fill="#e2e8f0" stroke="#475569" strokeWidth="1.4" />
    <rect x="9" y="9" width="12" height="12" fill="#bae6fd" stroke="#0284c7" strokeWidth="1.4" />
    <line x1="12" y1="15" x2="18" y2="15" stroke="#0369a1" strokeWidth="1.2" />
    <line x1="15" y1="12" x2="15" y2="18" stroke="#0369a1" strokeWidth="1.2" />
  </svg>
);

// 75. Snaps (Magnet)
export const IconSnaps: React.FC<IconProps> = ({ size = 20, className = '' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <path d="M5 4V11C5 14.9 8.1 18 12 18C15.9 18 19 14.9 19 11V4" stroke="#dc2626" strokeWidth="2.8" strokeLinecap="round" fill="none" />
    <path d="M9 4V11C9 12.7 10.3 14 12 14C13.7 14 15 12.7 15 11V4" stroke="#ffffff" strokeWidth="1.8" fill="none" />
    <rect x="3" y="3" width="4" height="4" fill="#94a3b8" />
    <rect x="17" y="3" width="4" height="4" fill="#94a3b8" />
  </svg>
);

// 76. Project Information
export const IconProjectInfo: React.FC<IconProps> = ({ size = 20, className = '' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <rect x="4" y="3" width="16" height="18" rx="2" fill="#ffffff" stroke="#475569" strokeWidth="1.4" />
    <circle cx="12" cy="12" r="5" fill="#0284c7" />
    <text x="12" y="15" textAnchor="middle" fontSize="9" fontWeight="bold" fill="#ffffff" fontFamily="sans-serif">i</text>
  </svg>
);

// 77. Parameters Service (Cloud parameters)
export const IconParametersService: React.FC<IconProps> = ({ size = 20, className = '' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <rect x="3" y="3" width="12" height="12" rx="1" fill="#f8fafc" stroke="#475569" strokeWidth="1.2" />
    <line x1="5" y1="7" x2="13" y2="7" stroke="#0284c7" strokeWidth="1.2" />
    <line x1="5" y1="10" x2="11" y2="10" stroke="#0284c7" strokeWidth="1.2" />
    <path d="M12 16C12 14 14 13 16 13C17.5 13 19 14 19 15.5C20 15.5 21 16.5 21 17.5C21 19 20 20 18.5 20H13C11.5 20 11 18.5 11 17.5C11 16.5 12 16 12 16Z" fill="#38bdf8" stroke="#0284c7" strokeWidth="1.2" />
  </svg>
);

// 78. Location (Globe with pin)
export const IconLocation: React.FC<IconProps> = ({ size = 20, className = '' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <circle cx="11" cy="13" r="8" stroke="#0284c7" strokeWidth="1.4" fill="#e0f2fe" />
    <ellipse cx="11" cy="13" rx="4" ry="8" stroke="#0284c7" strokeWidth="1" fill="none" />
    <line x1="3" y1="13" x2="19" y2="13" stroke="#0284c7" strokeWidth="1" />
    <path d="M17 3C15.3 3 14 4.3 14 6C14 8.5 17 12 17 12C17 12 20 8.5 20 6C20 4.3 18.7 3 17 3Z" fill="#ea580c" />
    <circle cx="17" cy="6" r="1" fill="#ffffff" />
  </svg>
);

// 79. Design Options
export const IconDesignOptions: React.FC<IconProps> = ({ size = 20, className = '' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <rect x="3" y="4" width="18" height="16" rx="1.5" fill="#ffffff" stroke="#475569" strokeWidth="1.4" />
    <rect x="5" y="7" width="3" height="3" fill="#0284c7" />
    <line x1="10" y1="8.5" x2="19" y2="8.5" stroke="#475569" strokeWidth="1.2" />
    <rect x="5" y="12" width="3" height="3" fill="#94a3b8" />
    <line x1="10" y1="13.5" x2="19" y2="13.5" stroke="#475569" strokeWidth="1.2" />
  </svg>
);

// 80. Phases
export const IconPhases: React.FC<IconProps> = ({ size = 20, className = '' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <rect x="3" y="4" width="18" height="17" rx="2" fill="#ffffff" stroke="#475569" strokeWidth="1.4" />
    <path d="M3 9H21" stroke="#0284c7" strokeWidth="1.5" />
    <line x1="8" y1="2" x2="8" y2="5" stroke="#475569" strokeWidth="1.5" strokeLinecap="round" />
    <line x1="16" y1="2" x2="16" y2="5" stroke="#475569" strokeWidth="1.5" strokeLinecap="round" />
    <circle cx="8" cy="13" r="1.5" fill="#16a34a" />
    <circle cx="12" cy="13" r="1.5" fill="#f59e0b" />
    <circle cx="16" cy="13" r="1.5" fill="#0284c7" />
  </svg>
);

// 81. Show Mass
export const IconShowMass: React.FC<IconProps> = ({ size = 20, className = '' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <ellipse cx="12" cy="6" rx="7" ry="3.5" fill="#e2e8f0" stroke="#475569" strokeWidth="1.4" />
    <path d="M5 6V16C5 18 8 20 12 20C16 20 19 18 19 16V6" fill="#f1f5f9" stroke="#475569" strokeWidth="1.4" />
    <ellipse cx="12" cy="16" rx="7" ry="3.5" fill="#cbd5e1" stroke="#475569" strokeWidth="1.2" strokeDasharray="2 2" />
  </svg>
);

// 82. In-Place Mass
export const IconInPlaceMass: React.FC<IconProps> = ({ size = 20, className = '' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <rect x="4" y="6" width="13" height="13" fill="#f8fafc" stroke="#475569" strokeWidth="1.4" />
    <polygon points="17,3 21,7 21,17 17,17" fill="#cbd5e1" stroke="#475569" strokeWidth="1.2" />
    <polygon points="4,6 8,2 21,2 17,6" fill="#e2e8f0" stroke="#475569" strokeWidth="1.2" />
    <polygon points="17,7 18.5,10 22,10.5 19.5,13 20,16.5 17,15 14,16.5 14.5,13 12,10.5 15.5,10" fill="#f59e0b" stroke="#d97706" strokeWidth="0.8" />
  </svg>
);

// 83. Place Mass
export const IconPlaceMass: React.FC<IconProps> = ({ size = 20, className = '' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <rect x="4" y="6" width="14" height="14" fill="#f8fafc" stroke="#475569" strokeWidth="1.4" />
    <path d="M16 2V9M16 9L13 6M16 9L19 6" stroke="#0284c7" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

// 84. Toposolid (Contoured solid with grass top)
export const IconToposolid: React.FC<IconProps> = ({ size = 20, className = '' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <polygon points="3,12 12,7 21,11 12,16" fill="#86efac" stroke="#16a34a" strokeWidth="1.4" />
    <polygon points="3,12 12,16 12,21 3,17" fill="#78350f" stroke="#451a03" strokeWidth="1.2" />
    <polygon points="12,16 21,11 21,16 12,21" fill="#92400e" stroke="#451a03" strokeWidth="1.2" />
  </svg>
);

// 85. Contextual Data
export const IconContextualData: React.FC<IconProps> = ({ size = 20, className = '' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <circle cx="11" cy="13" r="8" stroke="#475569" strokeWidth="1.5" fill="#f8fafc" />
    <line x1="3" y1="13" x2="19" y2="13" stroke="#475569" strokeWidth="1" />
    <ellipse cx="11" cy="13" rx="4" ry="8" stroke="#475569" strokeWidth="1" fill="none" />
    <polygon points="17,3 21,6 17,9 13,6" fill="#ec4899" stroke="#be185d" strokeWidth="1" />
  </svg>
);

// 86. Site Component (Tree)
export const IconSiteComponent: React.FC<IconProps> = ({ size = 20, className = '' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <polygon points="12,2 4,16 20,16" fill="#86efac" stroke="#16a34a" strokeWidth="1.5" strokeLinejoin="round" />
    <rect x="10.5" y="16" width="3" height="6" fill="#78350f" stroke="#451a03" strokeWidth="1" />
  </svg>
);

// 87. Parking Component
export const IconParkingComponent: React.FC<IconProps> = ({ size = 20, className = '' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <line x1="3" y1="12" x2="21" y2="12" stroke="#475569" strokeWidth="2" strokeLinecap="round" />
    <line x1="6" y1="4" x2="6" y2="20" stroke="#475569" strokeWidth="1.5" strokeLinecap="round" />
    <line x1="12" y1="4" x2="12" y2="20" stroke="#475569" strokeWidth="1.5" strokeLinecap="round" />
    <line x1="18" y1="4" x2="18" y2="20" stroke="#475569" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);

// 88. Property Line
export const IconPropertyLine: React.FC<IconProps> = ({ size = 20, className = '' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <path d="M4 19H16V7" stroke="#0284c7" strokeWidth="2" fill="none" />
    <circle cx="4" cy="19" r="2" fill="#0284c7" />
    <circle cx="16" cy="19" r="2" fill="#0284c7" />
    <circle cx="16" cy="7" r="2" fill="#0284c7" />
    <path d="M12 15C12 12 14 10 17 10" stroke="#38bdf8" strokeWidth="1.2" strokeDasharray="2 2" fill="none" />
  </svg>
);

// 89. Label Contours
export const IconLabelContours: React.FC<IconProps> = ({ size = 20, className = '' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <path d="M3 18C8 12 16 14 21 8" stroke="#94a3b8" strokeWidth="1.5" strokeLinecap="round" fill="none" />
    <text x="11" y="11" textAnchor="middle" fontSize="7" fontWeight="bold" fill="#64748b" fontFamily="sans-serif">50</text>
  </svg>
);

