import React from 'react';

/** Identify the host and the active project inside an inventory tab. */
export function ProjectTopbar({
  projectName
}: {
  projectName?: string;
}): React.ReactElement {
  return (
    <header className="jp-jupyterlab-lightcone-project-topbar">
      <span className="jp-jupyterlab-lightcone-project-brand">
        lightcone lab
      </span>
      {projectName ? (
        <span className="jp-jupyterlab-lightcone-project-name">
          {projectName}
        </span>
      ) : null}
    </header>
  );
}
