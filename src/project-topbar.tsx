import React from 'react';

/** Identify the host and the active project inside an inventory tab. */
export function ProjectTopbar({
  projectName,
  statusError
}: {
  projectName?: string;
  statusError?: string;
}): React.ReactElement {
  return (
    <header className="jp-jupyterlab-lightcone-project-topbar">
      <span className="jp-jupyterlab-lightcone-project-brand">
        Lightcone Lab
      </span>
      {projectName ? (
        <span className="jp-jupyterlab-lightcone-project-name">
          {projectName}
        </span>
      ) : null}
      {statusError ? (
        <span
          className="jp-jupyterlab-lightcone-status-error"
          role="status"
          title={statusError}
        >
          Materialization status unavailable
        </span>
      ) : null}
    </header>
  );
}
