import {
  displayPath,
  isFileLink,
  normalizeServerRoot,
  resolveChatLink,
  rewriteImageSource,
  serverRelativePath
} from '../chat-paths';

const ROOT = '/home/ada/repo/dev';
const BASE_URL = 'http://localhost:8888/lab-base/';

describe('serverRelativePath', () => {
  it('maps absolute paths inside the server root', () => {
    expect(serverRelativePath(`${ROOT}/my-project/results/a.png`, ROOT)).toBe(
      'my-project/results/a.png'
    );
    expect(serverRelativePath(ROOT, ROOT)).toBe('');
    expect(serverRelativePath(`${ROOT}/`, `${ROOT}/`)).toBe('');
  });

  it('decodes file URLs and percent-encoded paths', () => {
    expect(
      serverRelativePath(`file://${ROOT}/my%20project/plot%20a.py`, ROOT)
    ).toBe('my project/plot a.py');
    expect(serverRelativePath(`${ROOT}/my%20project/x.md`, ROOT)).toBe(
      'my project/x.md'
    );
  });

  it('drops queries and fragments from absolute paths', () => {
    expect(serverRelativePath(`${ROOT}/notes.md#section`, ROOT)).toBe(
      'notes.md'
    );
    expect(serverRelativePath(`${ROOT}/notes.md?x=1`, ROOT)).toBe('notes.md');
  });

  it('rejects paths outside the root, siblings with a shared prefix, and unknown roots', () => {
    expect(serverRelativePath('/etc/passwd', ROOT)).toBeUndefined();
    expect(serverRelativePath(`${ROOT}-other/x.md`, ROOT)).toBeUndefined();
    expect(serverRelativePath('relative/x.md', ROOT)).toBeUndefined();
    expect(serverRelativePath(`${ROOT}/x.md`, '')).toBeUndefined();
  });
});

describe('isFileLink', () => {
  it('accepts absolute paths in the root and relative paths', () => {
    expect(isFileLink(`${ROOT}/x.md`, ROOT)).toBe(true);
    expect(isFileLink(`file://${ROOT}/x.md`, ROOT)).toBe(true);
    expect(isFileLink('results/a.png', ROOT)).toBe(true);
    expect(isFileLink('./src/plot.py', ROOT)).toBe(true);
    expect(isFileLink('../sibling.md', ROOT)).toBe(true);
  });

  it('rejects external, fragment, protocol-relative and out-of-root links', () => {
    expect(isFileLink('https://example.org/x.md', ROOT)).toBe(false);
    expect(isFileLink('mailto:ada@example.org', ROOT)).toBe(false);
    expect(isFileLink('#top', ROOT)).toBe(false);
    expect(isFileLink('//cdn.example.org/a.png', ROOT)).toBe(false);
    expect(isFileLink('/etc/hosts', ROOT)).toBe(false);
    expect(isFileLink('', ROOT)).toBe(false);
  });
});

describe('resolveChatLink', () => {
  const context = { serverRoot: ROOT, baseDirectory: 'my-project' };

  it('resolves absolute paths through the server root', () => {
    expect(resolveChatLink(`${ROOT}/my-project/src/plot.py`, context)).toBe(
      'my-project/src/plot.py'
    );
    expect(resolveChatLink(`file://${ROOT}/README.md`, context)).toBe(
      'README.md'
    );
  });

  it('resolves relative paths against the base directory', () => {
    expect(resolveChatLink('results/baseline/a.png', context)).toBe(
      'my-project/results/baseline/a.png'
    );
    expect(resolveChatLink('./src/plot.py#L12', context)).toBe(
      'my-project/src/plot.py'
    );
    expect(
      resolveChatLink('../notes.md', { ...context, baseDirectory: 'a/b' })
    ).toBe('a/notes.md');
    expect(resolveChatLink('x.md', { ...context, baseDirectory: '' })).toBe(
      'x.md'
    );
    expect(resolveChatLink('.', context)).toBe('my-project');
  });

  it('refuses relative paths that escape the server root', () => {
    expect(
      resolveChatLink('../../x.md', { ...context, baseDirectory: 'a' })
    ).toBeUndefined();
    expect(
      resolveChatLink('../x.md', { ...context, baseDirectory: '' })
    ).toBeUndefined();
  });

  it('leaves external links alone', () => {
    expect(resolveChatLink('https://example.org', context)).toBeUndefined();
    expect(resolveChatLink('#anchor', context)).toBeUndefined();
    expect(resolveChatLink('/outside/root.md', context)).toBeUndefined();
  });
});

describe('rewriteImageSource', () => {
  const context = { serverRoot: ROOT, baseDirectory: 'my-project' };

  it('serves absolute and relative images through the files route', () => {
    expect(
      rewriteImageSource(
        `${ROOT}/my-project/results/a b.png`,
        context,
        BASE_URL
      )
    ).toBe('http://localhost:8888/lab-base/files/my-project/results/a%20b.png');
    expect(rewriteImageSource('results/a.png', context, BASE_URL)).toBe(
      'http://localhost:8888/lab-base/files/my-project/results/a.png'
    );
  });

  it('leaves served, external and root sources alone', () => {
    expect(
      rewriteImageSource(
        'http://localhost:8888/lab-base/files/x.png',
        context,
        BASE_URL
      )
    ).toBeUndefined();
    expect(
      rewriteImageSource('data:image/png;base64,AAAA', context, BASE_URL)
    ).toBeUndefined();
    expect(rewriteImageSource(ROOT, context, BASE_URL)).toBeUndefined();
  });
});

describe('path helpers', () => {
  it('normalizes roots and shortens project paths', () => {
    expect(normalizeServerRoot('/srv/root///')).toBe('/srv/root');
    expect(displayPath('my-project/src/plot.py', 'my-project')).toBe(
      'src/plot.py'
    );
    expect(displayPath('other/x.py', 'my-project')).toBe('other/x.py');
    expect(displayPath('x.py', '')).toBe('x.py');
  });
});
