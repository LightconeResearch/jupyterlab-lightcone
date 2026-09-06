import MarkdownIt from 'markdown-it';
import { astraRoles, mountRoles } from '../chat-markdown';

const role = '{astra}`decisions.method`';

describe('MySTRA chat roles', () => {
  test('recognizes rooted references and custom labels in prose', () => {
    expect(
      astraRoles(`See ${role} and **{astra}\`the fit <child.outputs.fit>\`**.`)
    ).toEqual([
      { body: 'decisions.method', target: 'decisions.method', display: null },
      {
        body: 'the fit <child.outputs.fit>',
        target: 'child.outputs.fit',
        display: 'the fit'
      }
    ]);
  });
  test('ignores code, escapes, links, malformed paths and incomplete streaming roles', () => {
    expect(
      astraRoles(
        '``' +
          role +
          '``\n\n```md\n' +
          role +
          '\n```\n\n\\' +
          role +
          '\n[' +
          role +
          '](https://example.com)\n{astra}`outputs..bad`\n{astra}`outputs.partial'
      )
    ).toEqual([]);
  });
  test('decorates and restores only matched inline nodes', () => {
    const root = document.createElement('div');
    const markdown = `See ${role} and {astra}\`plot <outputs.fit>\`.`;
    root.innerHTML = new MarkdownIt().render(markdown);
    const original = root.innerHTML;
    const mounts = mountRoles(root, astraRoles(markdown));
    expect(mounts).toHaveLength(2);
    expect(root.textContent).toBe('See  and .\n');
    mounts.forEach(mount => mount.restore());
    expect(root.innerHTML).toBe(original);
  });
  test('does not associate raw HTML lookalikes with prose roles', () => {
    expect(
      astraRoles(`{astra}<code>decisions.method</code>\n\n${role}`)
    ).toEqual([]);
  });
  test('leaves ambiguous escaped lookalikes untouched', () => {
    const markdown = `\\${role} and ${role}`;
    const root = document.createElement('div');
    root.innerHTML = new MarkdownIt().render(markdown);
    expect(mountRoles(root, astraRoles(markdown))).toEqual([]);
  });
});
