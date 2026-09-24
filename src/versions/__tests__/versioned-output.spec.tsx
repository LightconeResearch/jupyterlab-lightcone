import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ResolvedOutput } from '@astra-spec/sdk';
import type { OutputStatus } from '@astra-spec/ui/model';
import { ContentsManager, Drive, ServerConnection } from '@jupyterlab/services';
import { RequestError } from '../../api';
import type { ILoadedProjectData } from '../../project-data';
import { forgetVersions, listVersionsCached } from '../version-cache';
import {
  useOutputVersioning,
  VersionBar,
  VersionedArtifact,
  type IOutputVersioning
} from '../versioned-output';
import type { IOutputVersion } from '../versions-api';

jest.mock('../version-cache', () => ({
  listVersionsCached: jest.fn(),
  forgetVersions: jest.fn()
}));

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const list = jest.mocked(listVersionsCached);
const forget = jest.mocked(forgetVersions);

function version(commit: string, time: string): IOutputVersion {
  return {
    commit,
    short: commit.slice(0, 7),
    time,
    subject: '',
    size: null,
    present: true,
    annex: null,
    manifest: null
  };
}

const versions = [
  version('c'.repeat(40), '2026-09-20T10:00:00Z'),
  version('b'.repeat(40), '2026-09-18T10:00:00Z'),
  version('a'.repeat(40), '2026-09-15T10:00:00Z')
];

function output(canonicalPath = 'outputs.fit'): ResolvedOutput {
  return {
    kind: 'output',
    id: 'fit',
    canonicalPath,
    label: 'Fit',
    type: 'figure',
    format: 'png'
  } as unknown as ResolvedOutput;
}

const data = {
  document: { universe: { universeId: 'baseline', source: 'default' } },
  bindings: [],
  index: {
    analysisByRecordPath: new Map([
      ['outputs.fit', { canonicalPath: '$' }],
      ['systematics.outputs.fit', { canonicalPath: 'systematics' }]
    ])
  },
  papers: {}
} as unknown as ILoadedProjectData;

let contents: ContentsManager;
let container: HTMLDivElement;
let root: Root;
let latest: IOutputVersioning | undefined;

interface IProbeProps {
  selected: string | undefined;
  onSelect: (commit: string | undefined) => void;
  status?: OutputStatus;
  entrypoint?: string;
  record?: ResolvedOutput;
}

function Probe({
  selected,
  onSelect,
  status,
  entrypoint = 'project/astra.yaml',
  record = output()
}: IProbeProps): React.ReactElement {
  const versioning = useOutputVersioning(
    contents,
    entrypoint,
    data,
    record,
    status,
    selected,
    onSelect
  );
  latest = versioning;
  // Laid out as a record tab does: the bar above, the artifact in its frame.
  return (
    <>
      <VersionBar versioning={versioning} output={record} />
      <div className="frame">
        <VersionedArtifact
          versioning={versioning}
          output={record}
          compact={false}
          current={<p>current artifact</p>}
        />
      </div>
    </>
  );
}

/** A host that owns the selection, as a record tab does. */
function Host({
  initial,
  onSelect
}: {
  initial?: string;
  onSelect: jest.Mock;
}): React.ReactElement {
  const [selected, setSelected] = useState(initial);
  const [select] = useState(() => (commit: string | undefined) => {
    onSelect(commit);
    setSelected(commit);
  });
  return <Probe selected={selected} onSelect={select} />;
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  list.mockReset();
  forget.mockReset();
  latest = undefined;
  contents = new ContentsManager({
    serverSettings: ServerConnection.makeSettings({
      baseUrl: 'http://localhost:8888/lab/'
    })
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  contents.dispose();
});

test('shows the selected version and follows a selection changed by the host', async () => {
  list.mockResolvedValue({
    file: 'results/baseline/fit.png',
    annex: 'initialized',
    versions
  });
  const onSelect = jest.fn();
  act(() => {
    root.render(<Probe selected={'b'.repeat(40)} onSelect={onSelect} />);
  });
  await flush();
  expect(latest?.position).toEqual({ index: 1, ordinal: 2, total: 3 });
  expect(latest?.previous?.commit).toBe('a'.repeat(40));
  expect(latest?.isLatest).toBe(false);
  expect(container.textContent).toContain('Older version · v2 of 3');
  expect(container.textContent).not.toContain('current artifact');
  // A version requested while the output is shown (a chat card chip clicked
  // with the tab already open) takes effect without remounting.
  act(() => {
    root.render(<Probe selected={'a'.repeat(7)} onSelect={onSelect} />);
  });
  await flush();
  expect(latest?.shown?.commit).toBe('a'.repeat(40));
  expect(container.textContent).toContain('v1 of 3');
  act(() => {
    root.render(<Probe selected={undefined} onSelect={onSelect} />);
  });
  expect(latest?.shown?.commit).toBe('c'.repeat(40));
  expect(latest?.isLatest).toBe(true);
  expect(container.textContent).toContain('current artifact');
  expect(onSelect).not.toHaveBeenCalled();
});

test('keeps the stepper and the banner out of the zoomable artifact frame', async () => {
  list.mockResolvedValue({
    file: 'results/baseline/fit.png',
    annex: 'initialized',
    versions
  });
  act(() => {
    root.render(<Probe selected={'b'.repeat(40)} onSelect={jest.fn()} />);
  });
  await flush();
  const frame = container.querySelector('.frame')!;
  const bar = container.querySelector('.jp-jupyterlab-lightcone-VersionBar')!;
  expect(bar.textContent).toContain('Older version · v2 of 3');
  expect(bar.querySelector('[aria-label="Output versions"]')).not.toBeNull();
  expect(frame.querySelector('[aria-label="Output versions"]')).toBeNull();
  expect(frame.textContent).not.toContain('Older version');
  // A data file has no frame: its versions stay in the provenance rail.
  act(() => {
    root.render(
      <Probe
        selected={undefined}
        onSelect={jest.fn()}
        record={
          {
            ...output(),
            type: 'data',
            format: 'npz'
          } as unknown as ResolvedOutput
        }
      />
    );
  });
  await flush();
  expect(
    container.querySelector('.jp-jupyterlab-lightcone-VersionBar')
  ).toBeNull();
});

test('the stepper and the Latest button go through the host, closing the comparison', async () => {
  list.mockResolvedValue({
    file: 'results/baseline/fit.png',
    annex: 'initialized',
    versions
  });
  const onSelect = jest.fn();
  act(() => {
    root.render(<Host initial={'b'.repeat(40)} onSelect={onSelect} />);
  });
  await flush();
  act(() => latest?.setCompare(true));
  expect(latest?.compare).toBe(true);
  const latestButton = Array.from(container.querySelectorAll('button')).find(
    button => button.textContent === 'Latest'
  )!;
  act(() => latestButton.click());
  expect(onSelect).toHaveBeenLastCalledWith(undefined);
  expect(latest?.selected).toBeUndefined();
  expect(latest?.compare).toBe(false);
  act(() => latest?.select('a'.repeat(40)));
  await flush();
  expect(onSelect).toHaveBeenLastCalledWith('a'.repeat(40));
  expect(latest?.position?.ordinal).toBe(1);
});

test('a selected commit the history does not hold falls back to the newest', async () => {
  list.mockResolvedValue({
    file: 'results/baseline/fit.png',
    annex: 'initialized',
    versions
  });
  const onSelect = jest.fn();
  act(() => {
    root.render(<Host initial={'f'.repeat(7)} onSelect={onSelect} />);
  });
  await flush();
  expect(onSelect).toHaveBeenCalledWith(undefined);
  expect(latest?.shown?.commit).toBe('c'.repeat(40));
});

test('an output never materialized has an empty history; other failures are reported', async () => {
  list.mockRejectedValueOnce(
    new RequestError(
      'Versions',
      await ServerConnection.ResponseError.create(
        new Response('{"reason": "absent"}', { status: 404 })
      )
    )
  );
  act(() => {
    root.render(<Probe selected={undefined} onSelect={jest.fn()} />);
  });
  await flush();
  expect(latest).toMatchObject({
    enabled: true,
    versions: [],
    loading: false,
    error: undefined
  });
  list.mockRejectedValueOnce(new Error('boom'));
  act(() => {
    root.render(
      <Probe
        selected={undefined}
        onSelect={jest.fn()}
        status={{ state: 'stale' }}
      />
    );
  });
  await flush();
  expect(latest?.error).toBe('boom');
  // A changed status may mean a new run: the cached listing is bypassed.
  expect(forget).toHaveBeenCalledTimes(2);
  expect(list).toHaveBeenCalledTimes(2);
});

test('nested outputs and other drives have no versions', async () => {
  contents.addDrive(new Drive({ name: 'RTC' }));
  act(() => {
    root.render(
      <Probe
        selected={undefined}
        onSelect={jest.fn()}
        record={output('systematics.outputs.fit')}
      />
    );
  });
  expect(latest).toMatchObject({ enabled: false, target: undefined });
  act(() => {
    root.render(
      <Probe
        selected={undefined}
        onSelect={jest.fn()}
        entrypoint="RTC:project/astra.yaml"
      />
    );
  });
  await flush();
  expect(latest?.enabled).toBe(false);
  expect(list).not.toHaveBeenCalled();
  expect(container.textContent).toBe('current artifact');
});
