import React from 'react';

/**
 * A small drawing of two records feeding a third, for links that open the
 * pipeline. It takes the text colour of the control it sits in.
 */
export function PipelineGlyph(): React.ReactElement {
  return (
    <svg
      className="jp-jupyterlab-lightcone-PipelineGlyph"
      viewBox="0 0 14 12"
      width="14"
      height="12"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M3 3C7 3 7 6 11 6M3 9C7 9 7 6 11 6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
      />
      <circle cx="2.5" cy="3" r="1.8" fill="currentColor" />
      <circle cx="2.5" cy="9" r="1.8" fill="currentColor" />
      <circle cx="11.5" cy="6" r="1.8" fill="currentColor" />
    </svg>
  );
}
