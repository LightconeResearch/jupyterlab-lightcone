import {
  canGoBack,
  canGoForward,
  currentEntry,
  EMPTY_HISTORY,
  goToHistory,
  historyCaption,
  historyTrail,
  HISTORY_LIMIT,
  pushHistory,
  rememberScroll,
  selectEntryVersion,
  stepHistory,
  type IElementHistory,
  type IHistoryEntry
} from '../element-history';

function entry(target: string, versionCommit?: string): IHistoryEntry {
  return {
    reference: { entrypoint: 'project/astra.yaml', target, universeId: null },
    identity: JSON.stringify(['project/astra.yaml', target, null]),
    label: target.split('.').pop() ?? target,
    ...(versionCommit ? { versionCommit } : {})
  };
}

function trail(...targets: string[]): IElementHistory {
  return targets.reduce(
    (history, target) => pushHistory(history, entry(target)),
    EMPTY_HISTORY
  );
}

test('pushing appends, moving back and forward walks the same entries', () => {
  const history = trail('outputs.a', 'decisions.b', 'prior_insights.c');
  expect(history.index).toBe(2);
  expect(canGoBack(history)).toBe(true);
  expect(canGoForward(history)).toBe(false);
  const back = stepHistory(history, -1)!;
  expect(currentEntry(back)?.reference.target).toBe('decisions.b');
  expect(canGoForward(back)).toBe(true);
  expect(stepHistory(stepHistory(back, -1)!, -1)).toBeUndefined();
  expect(currentEntry(stepHistory(back, +1)!)?.reference.target).toBe(
    'prior_insights.c'
  );
  expect(stepHistory(history, 0)).toBeUndefined();
  expect(goToHistory(history, 0)?.index).toBe(0);
  expect(goToHistory(history, 2)).toBeUndefined();
  expect(goToHistory(history, 7)).toBeUndefined();
  expect(canGoBack(EMPTY_HISTORY)).toBe(false);
  expect(canGoForward(EMPTY_HISTORY)).toBe(false);
});

test('an entry keeps where it was scrolled through moves and a same-record refresh', () => {
  const left = rememberScroll(trail('outputs.a', 'decisions.b'), 120);
  expect(currentEntry(left)?.scrollTop).toBe(120);
  expect(left.entries[0].scrollTop).toBeUndefined();
  // Coming back after a further push still finds the offset.
  const next = pushHistory(left, entry('prior_insights.c'));
  expect(currentEntry(next)?.scrollTop).toBeUndefined();
  expect(currentEntry(stepHistory(next, -1)!)?.scrollTop).toBe(120);
  // Reopening the current record refreshes its label but keeps the offset.
  expect(currentEntry(pushHistory(left, entry('decisions.b')))?.scrollTop).toBe(
    120
  );
  // An unchanged offset and an empty history leave the history as it is.
  expect(rememberScroll(left, 120)).toBe(left);
  expect(rememberScroll(EMPTY_HISTORY, 5)).toBe(EMPTY_HISTORY);
});

test('pushing after going back drops the forward entries, as a browser does', () => {
  const back = stepHistory(trail('outputs.a', 'decisions.b'), -1)!;
  const next = pushHistory(back, entry('inputs.c'));
  expect(next.entries.map(item => item.reference.target)).toEqual([
    'outputs.a',
    'inputs.c'
  ]);
  expect(next.index).toBe(1);
});

test('reopening the current record refreshes it in place instead of duplicating', () => {
  const history = trail('outputs.a', 'decisions.b');
  const same = pushHistory(history, {
    ...entry('decisions.b', 'a889877abcdef'),
    label: 'Cosmological model'
  });
  expect(same.entries).toHaveLength(2);
  expect(currentEntry(same)?.label).toBe('Cosmological model');
  expect(currentEntry(same)?.versionCommit).toBe('a889877abcdef');
  // A later plain reopen keeps the version it was asked for.
  expect(
    currentEntry(pushHistory(same, entry('decisions.b')))?.versionCommit
  ).toBe('a889877abcdef');
});

test('keeps at most the newest entries', () => {
  let history = EMPTY_HISTORY;
  for (let index = 0; index < HISTORY_LIMIT + 5; index += 1)
    history = pushHistory(history, entry(`outputs.o${index}`));
  expect(history.entries).toHaveLength(HISTORY_LIMIT);
  expect(history.index).toBe(HISTORY_LIMIT - 1);
  expect(history.entries[0].reference.target).toBe('outputs.o5');
});

test('the trail names the last references leading to the current one', () => {
  const history = trail('outputs.a', 'decisions.b', 'prior_insights.c');
  const { crumbs, elided } = historyTrail(history);
  expect(elided).toBe(0);
  expect(crumbs.map(crumb => crumb.identifier)).toEqual([
    'outputs.a',
    'decisions.b',
    'prior_insights.c'
  ]);
  expect(crumbs.map(crumb => crumb.current)).toEqual([false, false, true]);
  // Each crumb carries the kind its path names, for its kind mark.
  expect(crumbs.map(crumb => crumb.kind)).toEqual([
    'output',
    'decision',
    'prior_insight'
  ]);
  expect(historyCaption(history)).toBe(
    'outputs.a › decisions.b › prior_insights.c'
  );
  const long = trail('a', 'b', 'c', 'd', 'e', 'f');
  expect(historyTrail(long, 3)).toEqual({
    elided: 3,
    crumbs: [
      // A bare step names a sub-analysis.
      {
        index: 3,
        identifier: 'd',
        label: 'd',
        kind: 'analysis',
        current: false
      },
      {
        index: 4,
        identifier: 'e',
        label: 'e',
        kind: 'analysis',
        current: false
      },
      { index: 5, identifier: 'f', label: 'f', kind: 'analysis', current: true }
    ]
  });
  expect(historyCaption(long, 3)).toBe('… › d › e › f');
  // Going back trims the trail to the entries before the current one.
  expect(historyCaption(stepHistory(history, -1)!)).toBe(
    'outputs.a › decisions.b'
  );
  expect(historyTrail(EMPTY_HISTORY)).toEqual({ crumbs: [], elided: 0 });
});

test('papers are identified by DOI and the root analysis by name', () => {
  const paper = pushHistory(EMPTY_HISTORY, {
    reference: {
      entrypoint: 'astra.yaml',
      target: '',
      doi: '10.1234/example',
      universeId: null
    },
    identity: 'paper',
    label: 'A paper'
  });
  expect(historyCaption(paper)).toBe('doi:10.1234/example');
  expect(historyCaption(trail(''))).toBe('analysis');
  expect(historyTrail(paper).crumbs[0].kind).toBe('paper');
  expect(historyTrail(trail('')).crumbs[0].kind).toBe('analysis');
});

test('the current entry keeps the version it shows through moves and reopens', () => {
  const history = trail('outputs.a', 'decisions.b');
  const back = stepHistory(history, -1)!;
  const stepped = selectEntryVersion(back, 'a889877');
  expect(currentEntry(stepped)?.versionCommit).toBe('a889877');
  // The other entries and the original history are untouched.
  expect(currentEntry(back)?.versionCommit).toBeUndefined();
  expect(stepped.entries[1].versionCommit).toBeUndefined();
  expect(selectEntryVersion(stepped, 'a889877')).toBe(stepped);
  // Forward and back again return to the stepped version.
  const returned = stepHistory(stepHistory(stepped, +1)!, -1)!;
  expect(currentEntry(returned)?.versionCommit).toBe('a889877');
  // A reopen without a version keeps it; one naming a version replaces it.
  expect(
    currentEntry(pushHistory(returned, entry('outputs.a')))?.versionCommit
  ).toBe('a889877');
  expect(
    currentEntry(pushHistory(returned, entry('outputs.a', 'b'.repeat(40))))
      ?.versionCommit
  ).toBe('b'.repeat(40));
  // Returning to the newest version clears it.
  expect(
    currentEntry(selectEntryVersion(returned, undefined))?.versionCommit
  ).toBeUndefined();
  expect(selectEntryVersion(EMPTY_HISTORY, 'a889877')).toBe(EMPTY_HISTORY);
});
