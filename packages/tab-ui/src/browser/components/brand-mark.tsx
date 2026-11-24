import * as React from "@theia/core/shared/react";

/** The SimpleTab mark (docs/brand/logo-mark.svg) as an inline, decorative SVG. */
export const BrandMark: React.FC<{ className?: string }> = ({ className }) => {
  const id = React.useId().replace(/:/g, "");
  return (
    <svg className={className} viewBox="-8 -8 176 192" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={`${id}-b`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#3D8BFF" />
          <stop offset="1" stopColor="#1E66F5" />
        </linearGradient>
        <linearGradient id={`${id}-v`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#8E6CF7" />
          <stop offset="1" stopColor="#6A47E0" />
        </linearGradient>
        <linearGradient id={`${id}-w`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#7C5CF2" />
          <stop offset="1" stopColor="#5B3BD6" />
        </linearGradient>
      </defs>
      <g strokeLinejoin="round" strokeWidth="6">
        <path d="M4 40 L96 2 L154 30 L56 76 L4 100 Z" fill={`url(#${id}-b)`} stroke={`url(#${id}-b)`} />
        <path d="M62 89 L112 64 L156 86 L156 111 L106 136 L62 114 Z" fill={`url(#${id}-v)`} stroke={`url(#${id}-v)`} />
        <path d="M4 153 L56 128 L108 153 L56 179 Z" fill={`url(#${id}-w)`} stroke={`url(#${id}-w)`} />
      </g>
    </svg>
  );
};
