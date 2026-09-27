import { nullTranslator, type ITranslator } from '@jupyterlab/translation';
import React from 'react';

const CLASS = 'jp-jupyterlab-lightcone-ProjectTopbar';

export interface IProjectTopbarProps {
  /** Why `lc status` could not be read, when it could not. */
  statusError?: string;
  translator?: ITranslator;
}

/** Identify the host inside an inventory tab. */
export function ProjectTopbar({
  statusError,
  translator
}: IProjectTopbarProps): React.ReactElement {
  const trans = (translator ?? nullTranslator).load('jupyterlab_lightcone');
  return (
    <header className={CLASS}>
      <span className={`${CLASS}-brand`}>
        <span className={`${CLASS}-logo`} aria-hidden="true" />
        {trans.__('Lightcone Lab')}
      </span>
      {statusError ? (
        <span
          className={`${CLASS}-statusError`}
          role="status"
          title={statusError}
        >
          {trans.__('Materialization status unavailable')}
        </span>
      ) : null}
    </header>
  );
}
