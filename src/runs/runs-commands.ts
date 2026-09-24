/** Command IDs of the runs area; Home and the sidebar execute these. */
export namespace RunsCommandIDs {
  /** Start `lc materialize` for a project and follow it in a notification. */
  export const materialize = 'jupyterlab_lightcone:materialize';
}

/** Typed arguments of the runs commands. */
export namespace RunsCommandArguments {
  export interface IMaterialize {
    /** Contents path of the project's `astra.yaml`; the current project otherwise. */
    entrypoint?: string;
    /** A folder to search for the project when no entrypoint is given. */
    cwd?: string;
    /** Output ids, or `<universe>/<output>`; everything when empty. */
    targets?: string[];
    /** Also remake outputs made under an earlier environment. */
    refresh?: boolean;
  }
}
