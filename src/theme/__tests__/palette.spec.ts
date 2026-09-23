import { readFileSync } from 'fs';
import { join } from 'path';
import { LIGHTCONE_DARK_THEME, LIGHTCONE_LIGHT_THEME } from '..';

/** One style rule of the theme stylesheet. */
interface IStyleRule {
  /** The selector, with whitespace collapsed. */
  selector: string;
  /** The declarations, by property name, with whitespace collapsed. */
  declarations: Map<string, string>;
}

/** The selector that scopes the dark palette, as JupyterLab stamps <body>. */
const DARK_SCOPE = `:root:has(> body[data-jp-theme-name='${LIGHTCONE_DARK_THEME}'])`;

/**
 * Parse the flat rules of a stylesheet without nested blocks.
 *
 * The theme stylesheet holds only top-level style rules and one `@import`,
 * so a comment-stripping brace scan is enough to read its variables.
 * @param css - The stylesheet text
 * @returns The style rules in source order
 */
function parseRules(css: string): IStyleRule[] {
  const text = css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/@import[^;]*;/g, '');
  const rules: IStyleRule[] = [];
  for (const match of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const declarations = new Map<string, string>();
    for (const declaration of match[2].split(';')) {
      const colon = declaration.indexOf(':');
      if (colon > 0) {
        declarations.set(
          declaration.slice(0, colon).trim(),
          declaration
            .slice(colon + 1)
            .replace(/\s+/g, ' ')
            .trim()
        );
      }
    }
    rules.push({
      selector: match[1].replace(/\s+/g, ' ').trim(),
      declarations
    });
  }
  return rules;
}

const rules = parseRules(
  readFileSync(join(__dirname, '..', '..', '..', 'style/themes/index.css'), {
    encoding: 'utf8'
  })
);

/**
 * The variables in force under one of the two themes.
 * @param name - The theme name
 * @returns The `:root` variables, with the dark overrides for the dark theme
 */
function palette(name: string): Map<string, string> {
  const base = rules.find(rule => rule.selector === ':root');
  const dark = rules.find(rule => rule.selector === DARK_SCOPE);
  if (!base || !dark) {
    throw new Error('The theme stylesheet lost its palette rules');
  }
  return name === LIGHTCONE_DARK_THEME
    ? new Map([...base.declarations, ...dark.declarations])
    : new Map(base.declarations);
}

/**
 * Resolve a variable to its value, following plain `var(--name)` references.
 * @param variables - The palette in force
 * @param name - The variable to resolve
 * @returns The resolved value
 */
function resolve(variables: Map<string, string>, name: string): string {
  const value = variables.get(name);
  if (value === undefined) {
    throw new Error(`${name} is not defined`);
  }
  const reference = /^var\((--[\w-]+)\)$/.exec(value);
  return reference ? resolve(variables, reference[1]) : value;
}

/**
 * The WCAG relative luminance of a hex color.
 * @param color - A `#rgb` or `#rrggbb` color
 * @returns The luminance, from 0 (black) to 1 (white)
 */
function luminance(color: string): number {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color);
  if (!hex) {
    throw new Error(`${color} is not a hex color`);
  }
  const digits =
    hex[1].length === 3
      ? hex[1]
          .split('')
          .map(digit => digit + digit)
          .join('')
      : hex[1];
  const [red, green, blue] = [0, 2, 4].map(offset => {
    const channel = parseInt(digits.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.03928
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

/**
 * The WCAG contrast ratio between two hex colors.
 * @param first - One color
 * @param second - The other color
 * @returns The ratio, from 1 to 21
 */
function contrast(first: string, second: string): number {
  const [light, dark] = [luminance(first), luminance(second)].sort(
    (a, b) => b - a
  );
  return (light + 0.05) / (dark + 0.05);
}

/**
 * Whether a selector lies wholly inside one `:where()`, which gives it zero
 * specificity so that any other rule setting the same property wins.
 * @param selector - The selector text
 * @returns True when the whole selector is a single `:where(…)`
 */
function hasZeroSpecificity(selector: string): boolean {
  if (!selector.startsWith(':where(')) {
    return false;
  }
  let depth = 0;
  for (let index = ':where'.length; index < selector.length; index++) {
    if (selector[index] === '(') {
      depth++;
    } else if (selector[index] === ')') {
      depth--;
      if (depth === 0) {
        return index === selector.length - 1;
      }
    }
  }
  return false;
}

describe('Lightcone theme stylesheet', () => {
  it('scopes the dark palette to the registered dark theme name', () => {
    expect(rules.map(rule => rule.selector)).toEqual(
      expect.arrayContaining([':root', DARK_SCOPE])
    );
    expect(palette(LIGHTCONE_LIGHT_THEME).get('--jp-layout-color0')).not.toBe(
      palette(LIGHTCONE_DARK_THEME).get('--jp-layout-color0')
    );
  });

  it.each([LIGHTCONE_LIGHT_THEME, LIGHTCONE_DARK_THEME])(
    'paints --lc-paper as the %s document surface with legible text on it',
    name => {
      const variables = palette(name);
      const paper = resolve(variables, '--lc-paper');
      // Home's desk panel and plates sit on --lc-paper and use UI text colors.
      const illegible = [
        '--jp-ui-font-color0',
        '--jp-ui-font-color1',
        '--jp-ui-font-color2'
      ].filter(text => contrast(paper, resolve(variables, text)) < 4.5);
      expect(illegible).toEqual([]);
      // Design section 11: documents and panels (paper) are the layout color 0.
      expect(paper).toBe(resolve(variables, '--jp-layout-color0'));
    }
  );

  it('fills in the stderr yellow-background foreground at zero specificity', () => {
    const yellow = rules.filter(rule =>
      rule.selector.includes('.ansi-yellow-bg')
    );
    expect(yellow).toHaveLength(1);
    expect(yellow[0].selector).toContain(DARK_SCOPE);
    expect(hasZeroSpecificity(yellow[0].selector)).toBe(true);
    expect(yellow[0].declarations.get('color')).toBe('#221f20');
  });
});
