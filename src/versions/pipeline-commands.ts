/** Command IDs of the pipeline view; Home and record tabs execute these. */
export namespace PipelineCommandIDs {
  /** Open a project's pipeline in the main area, optionally tracing one record. */
  export const openPipeline = 'jupyterlab_lightcone:open-pipeline';
}

/** Typed arguments of the pipeline commands. */
export namespace PipelineCommandArguments {
  export interface IOpenPipeline {
    /** Contents path of the project's `astra.yaml`; the current project otherwise. */
    entrypoint?: string;
    /** The same as `entrypoint`, for callers that pass a file path. */
    path?: string;
    /** A folder to search for the project when no entrypoint is given. */
    cwd?: string;
    /**
     * Canonical path of the input or output to trace, such as
     * `outputs.hubble_diagram`; the whole project when absent.
     */
    focus?: string;
  }
}
