import type { Contents } from '@jupyterlab/services';
import { useEffect, useState } from 'react';
import type { IProjectContext } from './element-reference';
import {
  acquireProjectDataService,
  type IProjectDataState
} from './project-data-service';

/** Share project resolution with every tab and visible chat card. */
export function useProject(
  contents: Contents.IManager,
  context: IProjectContext
): IProjectDataState & { fetchPaper: (doi: string) => void } {
  const [state, setState] = useState<IProjectDataState>({
    data: undefined,
    error: undefined
  });
  const [fetchPaper, setFetch] = useState<(doi: string) => void>(
    () => () => undefined
  );
  useEffect(() => {
    const lease = acquireProjectDataService(
      contents,
      context.entrypoint,
      context.universeId
    );
    let active = true;
    const update = () => {
      if (active) setState(lease.service.state);
    };
    lease.service.changed.connect(update);
    setFetch(() => (doi: string) => {
      void lease.service.fetchPaper(doi);
    });
    update();
    void lease.service.get().then(update, update);
    return () => {
      active = false;
      lease.service.changed.disconnect(update);
      lease.release();
    };
  }, [contents, context.entrypoint, context.universeId]);
  return { ...state, fetchPaper };
}
