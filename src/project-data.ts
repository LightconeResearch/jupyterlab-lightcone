import {
  AnalysisValidationError,
  assertProjectPath,
  collectCitedDois,
  indexAnalysis,
  resolveAnalysis,
  type AnalysisIndex,
  type ArtifactBinding,
  type ResolvedAnalysisBundle,
  type ResolvedAnalysisDocument
} from '@astra-spec/sdk';
import type { InventoryPaperMetadata } from '@astra-spec/ui/model';
import type { Contents } from '@jupyterlab/services';
import { collectPaperMetadata } from './api';
import { createJupyterProjectReader } from './project-reader';

export interface ILoadedProjectData {
  document: ResolvedAnalysisDocument;
  bindings: readonly ArtifactBinding[];
  index: AnalysisIndex;
  papers: Record<string, InventoryPaperMetadata>;
}

export interface IProjectResolution {
  bundle: ResolvedAnalysisBundle;
  /** Equality value for this resolution, including artifact cache tokens. */
  snapshot: string;
}

/** The universe a view is pinned to, or null when the project declares none. */
export function effectiveUniverseId(
  document: ResolvedAnalysisDocument
): string | null {
  const { source, universeId } = document.universe;
  return source === 'none' ? null : universeId;
}

/** Get an entrypoint's directory while retaining a Jupyter contents drive. */
export function projectDirectory(entrypoint: string): string {
  assertProjectPath(entrypoint);
  const slash = entrypoint.lastIndexOf('/');
  return slash < 0
    ? entrypoint.slice(0, entrypoint.indexOf(':') + 1)
    : entrypoint.slice(0, slash);
}

/**
 * Whether a Contents path lies in the project of `entrypoint` (its folder or
 * below), on the same drive. The project folder itself counts.
 */
export function isUnderProject(
  contents: Contents.IManager,
  entrypoint: string,
  path: string
): boolean {
  if (contents.driveName(path) !== contents.driveName(entrypoint)) {
    return false;
  }
  const root = contents.localPath(projectDirectory(entrypoint));
  const local = contents.localPath(path);
  return !root || local === root || local.startsWith(`${root}/`);
}

/** Resolve and validate an ASTRA entrypoint using the shared SDK. */
export async function resolveProject(
  contents: Contents.IManager,
  entrypoint = 'astra.yaml',
  universeId?: string
): Promise<IProjectResolution> {
  if (contents.localPath(entrypoint).split('/').pop() !== 'astra.yaml') {
    throw new Error(
      `Expected an astra.yaml project entrypoint: ${entrypoint}.`
    );
  }
  const reader = createJupyterProjectReader(
    contents,
    projectDirectory(entrypoint)
  );
  const bundle = await resolveAnalysis(
    reader,
    universeId === undefined ? {} : { universeId }
  );
  return { bundle, snapshot: JSON.stringify(bundle) };
}

/** Read optional cached paper metadata independently from project resolution. */
export function loadProjectPapers(
  contents: Contents.IManager,
  document: ResolvedAnalysisDocument
): Promise<Record<string, InventoryPaperMetadata>> {
  return collectPaperMetadata(
    contents.serverSettings,
    collectCitedDois(document)
  );
}

/** Assemble host metadata around the SDK's resolved document and index. */
export function assembleLoadedProject(
  bundle: ResolvedAnalysisBundle,
  papers: Record<string, InventoryPaperMetadata>
): ILoadedProjectData {
  return {
    document: bundle.document,
    bindings: bundle.bindings,
    index: indexAnalysis(bundle.document),
    papers
  };
}

/** Format validation diagnostics with their authored file and field locations. */
export function projectErrorMessage(error: unknown): string {
  if (error instanceof AnalysisValidationError) {
    return [
      error.message,
      ...error.issues.map(issue => {
        const location = [issue.file, issue.path].filter(Boolean).join(':');
        return `• ${location ? `${location}: ` : ''}${issue.message}`;
      })
    ].join('\n');
  }
  return error instanceof Error ? error.message : 'Project refresh failed.';
}
