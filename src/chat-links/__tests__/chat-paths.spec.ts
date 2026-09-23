import {
  displayPath,
  isFileLink,
  normalizeServerRoot,
  resolveChatLink,
  rewriteImageSource,
  serverRelativePath,
  serverRoots
} from '../chat-paths';

const ROOT = '/home/ada/repo/dev';
const ROOTS = [ROOT];
const BASE_URL = 'http://localhost:8888/lab-base/';

describe('serverRelativePath', () => {
  it('maps absolute paths inside the server root', () => {
    expect(serverRelativePath(`${ROOT}/my-project/results/a.png`, ROOTS)).toBe(
      'my-project/results/a.png'
    );
    expect(serverRelativePath(ROOT, ROOTS)).toBe('');
    expect(serverRelativePath(`${ROOT}/`, [`${ROOT}/`])).toBe('');
  });

  it('decodes file URLs and percent-encoded paths', () => {
    expect(
      serverRelativePath(`file://${ROOT}/my%20project/plot%20a.py`, ROOTS)
    ).toBe('my project/plot a.py');
    expect(serverRelativePath(`${ROOT}/my%20project/x.md`, ROOTS)).toBe(
      'my project/x.md'
    );
  });

  it('drops queries and fragments from absolute paths', () => {
    expect(serverRelativePath(`${ROOT}/notes.md#section`, ROOTS)).toBe(
      'notes.md'
    );
    expect(serverRelativePath(`${ROOT}/notes.md?x=1`, ROOTS)).toBe('notes.md');
  });

  it('rejects paths outside the root, siblings with a shared prefix, and unknown roots', () => {
    expect(serverRelativePath('/etc/passwd', ROOTS)).toBeUndefined();
    expect(serverRelativePath(`${ROOT}-other/x.md`, ROOTS)).toBeUndefined();
    expect(serverRelativePath('relative/x.md', ROOTS)).toBeUndefined();
    expect(serverRelativePath(`${ROOT}/x.md`, [])).toBeUndefined();
    expect(serverRelativePath(`${ROOT}/x.md`, [''])).toBeUndefined();
  });

  it('resolves dot segments before comparing with the root', () => {
    expect(serverRelativePath(`${ROOT}/../etc/passwd`, ROOTS)).toBeUndefined();
    expect(
      serverRelativePath(`${ROOT}/proj/../../../etc/passwd`, ROOTS)
    ).toBeUndefined();
    expect(
      serverRelativePath(`${ROOT}/%2e%2e/etc/passwd`, ROOTS)
    ).toBeUndefined();
    expect(
      serverRelativePath(`file://${ROOT}/a/%2E%2E/%2E%2E/x`, ROOTS)
    ).toBeUndefined();
    expect(serverRelativePath(`${ROOT}/a/../b.md`, ROOTS)).toBe('b.md');
    expect(serverRelativePath(`${ROOT}/./a//b.md`, ROOTS)).toBe('a/b.md');
    expect(serverRelativePath(`${ROOT}/a/..`, ROOTS)).toBe('');
  });

  it('accepts any known spelling of the root, preferring the innermost', () => {
    const roots = ['/nfs/home/ada/repo/dev', ROOT];
    expect(serverRelativePath('/nfs/home/ada/repo/dev/x.md', roots)).toBe(
      'x.md'
    );
    expect(serverRelativePath(`${ROOT}/x.md`, roots)).toBe('x.md');
    expect(serverRelativePath('/srv/a/b/x.md', ['/srv', '/srv/a/b'])).toBe(
      'x.md'
    );
  });

  it('serves a filesystem root', () => {
    expect(serverRelativePath('/etc/hosts', ['/'])).toBe('etc/hosts');
    expect(serverRelativePath('/', ['/'])).toBe('');
  });
});

describe('serverRoots', () => {
  it('keeps the configured and resolved roots without repeats', () => {
    expect(
      serverRoots({
        lightconeServerRoot: `${ROOT}/`,
        rootUri: 'file:///nfs/home/ada/repo/my%20dev',
        serverRoot: '~/repo/dev'
      })
    ).toEqual([ROOT, '/nfs/home/ada/repo/my dev']);
    expect(
      serverRoots({ rootUri: `file://${ROOT}`, serverRoot: ROOT })
    ).toEqual([ROOT]);
  });

  it('ignores roots shortened to the home directory and non-file URIs', () => {
    expect(serverRoots({ serverRoot: '~/repo/dev' })).toEqual([]);
    expect(serverRoots({ serverRoot: '~' })).toEqual([]);
    expect(
      serverRoots({ rootUri: 'https://example.org/x', serverRoot: '/srv/x///' })
    ).toEqual(['/srv/x']);
    expect(serverRoots({ rootUri: 'not a url', serverRoot: '' })).toEqual([]);
    expect(serverRoots({})).toEqual([]);
  });

  it('matches agent paths when JupyterLab shortens the root to ~', () => {
    const roots = serverRoots({
      lightconeServerRoot: ROOT,
      serverRoot: '~/repo/dev'
    });
    expect(serverRelativePath(`${ROOT}/p/src/a.py`, roots)).toBe('p/src/a.py');
  });
});

describe('isFileLink', () => {
  it('accepts absolute paths in the root and relative paths', () => {
    expect(isFileLink(`${ROOT}/x.md`, ROOTS)).toBe(true);
    expect(isFileLink(`file://${ROOT}/x.md`, ROOTS)).toBe(true);
    expect(isFileLink('results/a.png', ROOTS)).toBe(true);
    expect(isFileLink('./src/plot.py', ROOTS)).toBe(true);
    expect(isFileLink('../sibling.md', ROOTS)).toBe(true);
  });

  it('rejects external, fragment, protocol-relative and out-of-root links', () => {
    expect(isFileLink('https://example.org/x.md', ROOTS)).toBe(false);
    expect(isFileLink('mailto:ada@example.org', ROOTS)).toBe(false);
    expect(isFileLink('#top', ROOTS)).toBe(false);
    expect(isFileLink('//cdn.example.org/a.png', ROOTS)).toBe(false);
    expect(isFileLink('/etc/hosts', ROOTS)).toBe(false);
    expect(isFileLink(`${ROOT}/../etc/hosts`, ROOTS)).toBe(false);
    expect(isFileLink('', ROOTS)).toBe(false);
  });
});

describe('resolveChatLink', () => {
  const context = { serverRoots: ROOTS, baseDirectory: 'my-project' };

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
    expect(resolveChatLink(`${ROOT}/../x.md`, context)).toBeUndefined();
  });
});

describe('rewriteImageSource', () => {
  const context = { serverRoots: ROOTS, baseDirectory: 'my-project' };

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

  it('leaves served, external, root and out-of-root sources alone', () => {
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
    expect(
      rewriteImageSource(`${ROOT}/../x.png`, context, BASE_URL)
    ).toBeUndefined();
  });
});

describe('path helpers', () => {
  it('normalizes roots and shortens project paths', () => {
    expect(normalizeServerRoot('/srv/root///')).toBe('/srv/root');
    expect(normalizeServerRoot('/srv/a/../root')).toBe('/srv/root');
    expect(normalizeServerRoot('/')).toBe('/');
    expect(normalizeServerRoot('~/repo')).toBe('');
    expect(normalizeServerRoot('')).toBe('');
    expect(displayPath('my-project/src/plot.py', 'my-project')).toBe(
      'src/plot.py'
    );
    expect(displayPath('other/x.py', 'my-project')).toBe('other/x.py');
    expect(displayPath('x.py', '')).toBe('x.py');
  });
});
