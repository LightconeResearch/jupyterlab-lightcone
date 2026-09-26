/** Commands registered by the Home plugin. */
export namespace HomeCommandIDs {
  /** The stock launcher command, redeclared so every entry point opens Home. */
  export const create = 'launcher:create';
  /** Recreate a Home tab from the saved layout; the layout restorer runs it. */
  export const restore = 'jupyterlab_lightcone:restore-home';
  /** Show a project's Home: the open tab showing it, or a new one. */
  export const openHome = 'jupyterlab_lightcone:open-home';
  /** The single card shown outside a project. */
  export const newProject = 'jupyterlab_lightcone:new-project';
  /** Switch a Home tab to the stock launcher body. */
  export const showLauncher = 'jupyterlab_lightcone:show-launcher';
  /** Switch a Home tab back from the stock launcher body. */
  export const showHome = 'jupyterlab_lightcone:show-home';
}
