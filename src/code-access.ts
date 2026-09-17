import type { ResolvedOutput } from '@astra-spec/sdk';
import { PathExt } from '@jupyterlab/coreutils';
import type { Contents } from '@jupyterlab/services';
import { parse } from 'shell-quote';
import { isRootAnalysisOutput } from './materialization-status';
import { projectDirectory, type ILoadedProjectData } from './project-data';

export interface ICodeReference {
  path: string;
  relativePath: string;
  source: 'recorded run' | 'declared recipe';
}

/**
 * Recognize a direct script invocation without interpreting or running shell code.
 *
 * `inputSources` maps input id to declared source, so a recipe that names its
 * script through the `{inputs.<id>}` placeholder resolves from the declaration
 * rather than from a path the command never spells out.
 */
export function scriptFromCommand(
  command: string,
  inputSources?: ReadonlyMap<string, string>
): string | undefined {
  // Substitution and multi-line commands stay opaque; `parse` only throws on `$`.
  if (/[\n\r`$]/.test(command)) return undefined;
  const tokens = parse(command);
  if (!tokens.every((token): token is string => typeof token === 'string'))
    return undefined;
  const words =
    tokens[0] === 'uv' && tokens[1] === 'run' ? tokens.slice(2) : tokens;
  const executable = words[0] ?? '';
  let candidate: string | undefined;
  if (/^(python(?:\d+(?:\.\d+)*)?|Rscript|node|bash|sh)$/.test(executable)) {
    candidate = words[1];
  } else if (executable.startsWith('./')) {
    candidate = executable;
  }
  const declared = candidate?.match(/^\{inputs\.([^{}]+)\}$/);
  if (declared) candidate = inputSources?.get(declared[1]);
  if (
    !candidate ||
    candidate.startsWith('-') ||
    /[{}~:\\]/.test(candidate) ||
    candidate.startsWith('/') ||
    candidate.split('/').includes('..')
  )
    return undefined;
  if (!/\.(py|r|js|mjs|cjs|sh)$/i.test(candidate)) return undefined;
  return PathExt.normalize(candidate);
}

/**
 * Locate the current working file named by this output's recipe.
 *
 * `recordedCommand` is the recipe from a matching Lightcone run record; when
 * given it takes precedence over the declared recipe, since it is what
 * actually produced the artifact.
 */
export async function resolveOutputCode(
  contents: Contents.IManager,
  entrypoint: string,
  data: ILoadedProjectData,
  output: ResolvedOutput,
  recordedCommand?: string
): Promise<ICodeReference | undefined> {
  // The resolved SDK does not expose path-backed subanalysis working directories.
  // Until it does, do not guess which same-named script a nested recipe used.
  if (!isRootAnalysisOutput(data, output)) return undefined;
  const command = recordedCommand ?? output.recipe?.command;
  if (!command) return undefined;
  const inputSources = new Map(
    output.provenance.inputPaths.flatMap(path => {
      const record = data.index.recordByPath.get(path);
      return record?.kind === 'input' && record.source
        ? ([[record.id, record.source]] as [string, string][])
        : [];
    })
  );
  const relativePath = scriptFromCommand(command, inputSources);
  if (!relativePath) return undefined;
  const path = contents.resolvePath(projectDirectory(entrypoint), relativePath);
  try {
    // One metadata request; a listing cache would not outlive this call.
    if ((await contents.get(path, { content: false })).type !== 'file')
      return undefined;
  } catch {
    /* Missing or unreadable locations have no navigation action. */
    return undefined;
  }
  return {
    path,
    relativePath,
    source: recordedCommand ? 'recorded run' : 'declared recipe'
  };
}
