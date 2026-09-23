/** Commands the sidebar plugin registers. */
export namespace SidebarCommandIDs {
  /** Reveal the Lightcone sidebar in the left area. */
  export const showSidebar = 'jupyterlab_lightcone:show-sidebar';
}

/**
 * Commands other parts of the workbench register. The sidebar only executes
 * them, and hides the entries whose command is not registered.
 */
export namespace WorkbenchCommandIDs {
  /** JupyterLab's launcher, which the Home plugin turns into Home. */
  export const createLauncher = 'launcher:create';
  /** Reveal the file browser at a path. */
  export const goToPath = 'filebrowser:go-to-path';
  /** The Ctrl+K search modal. */
  export const search = 'jupyterlab_lightcone:search';
  /** The Runs view. */
  export const openRuns = 'jupyterlab_lightcone:open-runs';
}
