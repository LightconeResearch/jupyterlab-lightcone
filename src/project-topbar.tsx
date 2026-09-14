import React from 'react';

/** Identify the host inside an inventory tab. */
export function ProjectTopbar(): React.ReactElement {
  return (
    <header className="jp-jupyterlab-lightcone-project-topbar">
      <span className="jp-jupyterlab-lightcone-project-brand">
        <span
          className="jp-jupyterlab-lightcone-project-logo"
          aria-hidden="true"
        />
        Lightcone Lab
      </span>
    </header>
  );
}
