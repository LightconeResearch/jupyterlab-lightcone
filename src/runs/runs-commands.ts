/** Command IDs of the runs area; Home and the sidebar execute these. */
export namespace RunsCommandIDs {
  /** Open the Runs view of a project in the main area. */
  export const openRuns = 'jupyterlab_lightcone:open-runs';
  /** Start `lc materialize` for a project and open its Runs view. */
  export const materialize = 'jupyterlab_lightcone:materialize';
}

/** Typed arguments of the runs commands. */
export namespace RunsCommandArguments {
  export interface IOpenRuns {
    /** Contents path of the project's `astra.yaml`; the current project otherwise. */
    entrypoint?: string;
    /** A folder to search for the project when no entrypoint is given. */
    cwd?: string;
    /** Whether to activate the view; defaults to true. */
    activate?: boolean;
  }

  export interface IMaterialize {
    /** Contents path of the project's `astra.yaml`; the current project otherwise. */
    entrypoint?: string;
    /** Output ids, or `<universe>/<output>`; everything when empty. */
    targets?: string[];
    /** Also remake outputs made under an earlier environment. */
    refresh?: boolean;
  }
}
