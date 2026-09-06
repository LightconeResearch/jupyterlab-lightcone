import MarkdownIt from 'markdown-it';
import { parseAstraPath, splitDisplay } from './vendor/mystra-path';

export interface IAstraRole {
  body: string;
  target: string;
  display: string | null;
}

const parser = new MarkdownIt('commonmark');
parser.inline.ruler.before('text', 'astra', (state, silent) => {
  const match = /^\{astra\}`([^`\n]+)`(?!`)/.exec(state.src.slice(state.pos));
  if (!match || match[1].length > 2048) return false;
  if (!silent) {
    const token = state.push('astra', '', 0);
    token.content = match[1];
  }
  state.pos += match[0].length;
  return true;
});

/** Parse prose only: escaped roles, fenced/inline code and HTML remain ordinary Markdown. */
export function astraRoles(source: string): IAstraRole[] {
  if (source.length > 200000) return [];
  const tokens = parser.parse(source, {});
  // Raw HTML can imitate role fragments after sanitizing or a renderer change.
  if (
    tokens.some(
      block =>
        block.type === 'html_block' ||
        block.children?.some(token => token.type === 'html_inline')
    )
  )
    return [];
  return tokens
    .flatMap(block => {
      let linkDepth = 0;
      return (block.children ?? []).flatMap(token => {
        if (token.type === 'link_open') linkDepth++;
        if (token.type === 'link_close') linkDepth--;
        if (token.type !== 'astra' || linkDepth) return [];
        const { display, path } = splitDisplay(token.content);
        try {
          parseAstraPath(path);
        } catch {
          return [];
        }
        return path ? [{ body: token.content, target: path, display }] : [];
      });
    })
    .slice(0, 100);
}

export interface IRoleMount {
  role: IAstraRole;
  node: HTMLElement;
  restore: () => void;
}

/** Decorate only an exact source/DOM match. A changed upstream DOM safely leaves Markdown intact. */
export function mountRoles(
  root: HTMLElement,
  roles: IAstraRole[]
): IRoleMount[] {
  const candidates = Array.from(root.querySelectorAll('code')).filter(
    code =>
      !code.closest('pre, a, .jp-jupyterlab-lightcone-reference') &&
      code.previousSibling?.nodeType === Node.TEXT_NODE &&
      code.previousSibling.textContent?.endsWith('{astra}')
  );
  // Ambiguity (including an escaped lookalike) must never link the wrong passage.
  if (
    candidates.length !== roles.length ||
    candidates.some((code, i) => code.textContent !== roles[i].body)
  )
    return [];
  return candidates.map((code, i) => {
    const text = code.previousSibling as Text;
    const original = text.data;
    const node = document.createElement('span');
    node.className = 'jp-jupyterlab-lightcone-reference';
    text.data = original.slice(0, -7);
    code.replaceWith(node);
    return {
      role: roles[i],
      node,
      restore: () => {
        if (node.parentNode && text.nextSibling === node) {
          text.data = original;
          node.replaceWith(code);
        }
      }
    };
  });
}
