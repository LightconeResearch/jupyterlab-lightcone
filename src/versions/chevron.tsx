import React from 'react';

/**
 * A back or forward chevron for small navigation buttons. It is drawn in the
 * button's text colour, so a disabled button dims it, and it keeps its size
 * whatever the font: the ◀ ▶ glyphs shrink to dots in the brand serif.
 */
export function Chevron({
  direction
}: {
  direction: 'back' | 'forward';
}): React.ReactElement {
  return (
    <svg
      className="jp-jupyterlab-lightcone-Chevron"
      width="14"
      height="14"
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d={direction === 'back' ? 'M10 3 5 8l5 5' : 'M6 3l5 5-5 5'}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
