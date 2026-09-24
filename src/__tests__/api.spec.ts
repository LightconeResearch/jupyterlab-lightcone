import { ServerConnection } from '@jupyterlab/services';
import {
  collectPaperMetadata,
  fetchPaper,
  isNotFoundResponse,
  isStringRecord,
  paperPdfUrl
} from '../api';

const settings = ServerConnection.makeSettings({
  baseUrl: 'https://example.org/user/researcher/'
});

beforeEach(() => {
  jest.restoreAllMocks();
});

it('keeps cached PDF URLs on the configured JupyterHub origin', () => {
  const url = new URL(paperPdfUrl(settings, 'https://doi.org/10.1234/Paper'));
  expect(url.pathname).toBe(
    '/user/researcher/jupyterlab_lightcone/api/papers/pdf'
  );
  expect(url.searchParams.get('doi')).toBe('10.1234/paper');
});

it('batches cached lookups, validates metadata, and never downloads automatically', async () => {
  const request = jest
    .spyOn(ServerConnection, 'makeRequest')
    .mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            papers: { '10.1234/0': { doi: '10.1234/0', title: 'Cached paper' } }
          })
        )
    );
  const papers = await collectPaperMetadata(
    settings,
    Array.from({ length: 41 }, (_, i) => `10.1234/${i}`)
  );
  expect(request).toHaveBeenCalledTimes(2);
  expect(
    new URL(request.mock.calls[0][0]).searchParams.getAll('doi')
  ).toHaveLength(40);
  expect(
    request.mock.calls.every(
      ([url, init]) => !url.includes('/fetch') && !init.method
    )
  ).toBe(true);
  expect(papers['10.1234/0'].title).toBe('Cached paper');
});

it('distinguishes unavailable paper services from an empty cache', async () => {
  jest.spyOn(ServerConnection, 'makeRequest').mockResolvedValue(
    new Response(JSON.stringify({ message: 'Permission denied' }), {
      status: 403
    })
  );
  await expect(
    collectPaperMetadata(settings, ['10.1234/paper'])
  ).rejects.toThrow('403');
});

it('rejects malformed successful responses instead of treating them as a cache miss', async () => {
  jest
    .spyOn(ServerConnection, 'makeRequest')
    .mockResolvedValue(new Response(JSON.stringify({ papers: [] })));
  await expect(
    collectPaperMetadata(settings, ['10.1234/paper'])
  ).rejects.toThrow('invalid paper metadata');
});

it('fetches normalized DOIs explicitly and requires the response to match', async () => {
  const request = jest.spyOn(ServerConnection, 'makeRequest').mockResolvedValue(
    new Response(
      JSON.stringify({
        paper: { doi: '10.1234/paper', authors: 'Test Author' }
      })
    )
  );
  const paper = await fetchPaper('DOI:10.1234/Paper', settings);
  expect(request.mock.calls[0][1]).toMatchObject({
    method: 'POST',
    body: '{"doi":"10.1234/paper"}'
  });
  expect(paper.authors).toBe('Test Author');
  request.mockResolvedValue(
    new Response(JSON.stringify({ paper: { doi: '10.1234/different' } }))
  );
  await expect(fetchPaper('10.1234/paper', settings)).rejects.toThrow(
    'invalid paper metadata'
  );
});

it('does not render server HTML in user-facing errors', async () => {
  jest
    .spyOn(ServerConnection, 'makeRequest')
    .mockResolvedValue(
      new Response(
        '<!DOCTYPE html><html><body>private diagnostic</body></html>',
        { status: 502 }
      )
    );
  await expect(fetchPaper('10.1234/paper', settings)).rejects.toThrow(
    'Paper request failed (502):'
  );
});

it('narrows string maps and the Jupyter server’s 404 answers', () => {
  expect(isStringRecord({ a: '1', b: '2' })).toBe(true);
  expect(isStringRecord({})).toBe(true);
  expect(isStringRecord({ a: 1 })).toBe(false);
  expect(isStringRecord(['a'])).toBe(false);
  expect(isStringRecord(null)).toBe(false);
  const missing = new ServerConnection.ResponseError(
    new Response(null, { status: 404 })
  );
  const denied = new ServerConnection.ResponseError(
    new Response(null, { status: 403 })
  );
  expect(isNotFoundResponse(missing)).toBe(true);
  expect(isNotFoundResponse(denied)).toBe(false);
  // Only the server's answer counts, not a look-alike object or message.
  expect(isNotFoundResponse({ status: 404 })).toBe(false);
  expect(isNotFoundResponse(new Error('404'))).toBe(false);
});
