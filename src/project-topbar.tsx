import React from 'react';

/** Identify the host inside an inventory tab. */
export function ProjectTopbar({
  statusError
}: {
  statusError?: string;
}): React.ReactElement {
  return (
    <header className="jp-jupyterlab-lightcone-project-topbar">
      <span className="jp-jupyterlab-lightcone-project-brand">
        <span
          className="jp-jupyterlab-lightcone-project-logo"
          aria-hidden="true"
        />
        Lightcone Lab
      </span>
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
