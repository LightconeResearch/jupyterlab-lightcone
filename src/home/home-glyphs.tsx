import React from 'react';

/** The stroke of each glyph, on a 12×12 grid. */
const GLYPH_PATHS = {
  /** After a link that leads to another view. */
  chevron: 'M4.5 2.5 8 6l-3.5 3.5',
  /** After a button that opens a menu. */
  chevronDown: 'M2.5 4.5 6 8l3.5-3.5',
  /** A terminal prompt, for the Tools menu of notebooks, consoles and terminals. */
  prompt: 'M2 3.5 4.5 6 2 8.5M6 9h4',
  /** After Start, which sends the message. */
  arrow: 'M2 6h8M7 3l3 3-3 3'
};

export type HomeGlyphName = keyof typeof GLYPH_PATHS;

/**
 * A small stroked glyph for Home's links and buttons. It takes the text
 * colour of the control it sits in, and stays out of its accessible name.
 * @param name - Which glyph to draw
 */
export function HomeGlyph({
  name
}: {
  name: HomeGlyphName;
}): React.ReactElement {
  return (
    <svg
      className="jp-jupyterlab-lightcone-HomeGlyph"
      viewBox="0 0 12 12"
      width="12"
      height="12"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d={GLYPH_PATHS[name]}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
