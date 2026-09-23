import type { Event } from '@jupyterlab/services';
import { ServerConnection } from '@jupyterlab/services';
import { Stream } from '@lumino/signaling';
import { RequestError } from '../../api';
import { JOB_EVENT_SCHEMA, type IJob, type IRunRecord } from '../runs-api';
import { RunsService } from '../runs-service';

/** Let pending promise callbacks and zero-delay timers run. */
export const flush = (): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, 0));

/** Wait for an asynchronous condition, counting rounds rather than time. */
export async function until(
  condition: () => boolean,
  rounds = 400
): Promise<void> {
  for (let round = 0; !condition(); round++) {
    if (round >= rounds) {
      throw new Error('Timed out waiting for a condition.');
    }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

/** The server's event bus, as the frontend sees it. */
export class FakeEvents implements Event.IManager {
  readonly serverSettings = ServerConnection.makeSettings();
  readonly stream: Stream<Event.IManager, Event.Emission>;
  isDisposed = false;

  constructor() {
    this.stream = new Stream<Event.IManager, Event.Emission>(this);
  }

  dispose(): void {
    this.isDisposed = true;
    this.stream.stop();
  }

  emit(): Promise<void> {
    return Promise.resolve();
  }
}

/** A running job of the `proj` project; override what a test needs. */
export function job(overrides: Partial<IJob> = {}): IJob {
  return {
    id: 'job-1',
    project: 'proj',
    targets: [],
    refresh: false,
    state: 'running',
    started: '2026-09-23T11:58:30.000Z',
    finished: null,
    exit: null,
    lines: [],
    report: null,
    ...overrides
  };
}

/** A materialization commit; override what a test needs. */
export function run(overrides: Partial<IRunRecord> = {}): IRunRecord {
  return {
    commit: 'a889877deadbeef',
    short: 'a889877',
    time: '2026-09-23T09:00:00.000Z',
    output: 'hubble_diagram',
    universe: 'baseline',
    exit: 0,
    cmd: 'python src/plot.py',
    inputs: [],
    outputs: [],
    ...overrides
  };
}

/** A server refusal with this HTTP status, as the runs API reports it. */
export function refused(status: number): RequestError {
  return new RequestError(
    'Runs',
    new ServerConnection.ResponseError(new Response('', { status }))
  );
}

/** A real runs service on a fake event bus; the runs API must be mocked. */
export function runsHost(): {
  service: RunsService;
  changes: string[];
  emit: (data: Record<string, string | null>) => void;
  dispose: () => void;
} {
  const events = new FakeEvents();
  const service = new RunsService(events.serverSettings, events);
  const changes: string[] = [];
  service.changed.connect((_, entrypoint) => changes.push(entrypoint));
  const emit = (data: Record<string, string | null>) =>
    events.stream.emit({ schema_id: JOB_EVENT_SCHEMA, ...data });
  return {
    service,
    changes,
    emit,
    dispose: () => {
      service.dispose();
      events.dispose();
    }
  };
}
