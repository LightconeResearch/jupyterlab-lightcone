/** Commands the sidebar plugin registers. */
export namespace SidebarCommandIDs {
  /** Reveal the Lightcone sidebar in the left area. */
  export const showSidebar = 'jupyterlab_lightcone:show-sidebar';
}

/**
 * JupyterLab commands the sidebar executes. Lightcone commands come from the
 * areas that register them (`SearchCommandIDs`, `CommandIDs`,
 * `HomeCommandIDs`); the sidebar hides an entry whose command is not
 * registered.
 */
export namespace WorkbenchCommandIDs {
  /** Reveal the file browser at a path. */
  export const goToPath = 'filebrowser:go-to-path';
}
