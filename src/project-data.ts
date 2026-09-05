import {
  AnalysisValidationError,
  indexAnalysis,
  projectDirname,
  resolveAnalysis,
  type AnalysisIndex,
  type ResolvedAnalysisBundle
} from '@astra-spec/sdk';
import {
  createJupyterProjectReader,
  type ProjectContents
} from './project-reader';

export interface ILoadedProject extends ResolvedAnalysisBundle {
  index: AnalysisIndex;
}

/** Resolve through the SDK, preserving the entrypoint's configured Contents drive. */
export async function loadProject(
  contents: ProjectContents,
  entrypoint: string
): Promise<ILoadedProject> {
  const localPath = contents.localPath(entrypoint);
  if (localPath.split('/').pop() !== 'astra.yaml') {
    throw new Error(`Open an astra.yaml entrypoint, received ${entrypoint}.`);
  }
  const drive = contents.driveName(entrypoint);
  const root = `${drive ? `${drive}:` : ''}${projectDirname(localPath)}`;
  const bundle = await resolveAnalysis(
    createJupyterProjectReader(contents, root)
  );
  return { ...bundle, index: indexAnalysis(bundle.document) };
}

/** Keep SDK validation locations visible in the document's error state. */
export function projectErrorMessage(error: unknown): string {
  if (error instanceof AnalysisValidationError) {
    return [
      error.message,
      ...error.issues.map(issue => {
        const location = [issue.file, issue.path].filter(Boolean).join(':');
        return `${location ? `${location}: ` : ''}${issue.message}`;
      })
    ].join('\n');
  }
  return error instanceof Error
    ? error.message
    : 'Could not load the ASTRA project.';
}
