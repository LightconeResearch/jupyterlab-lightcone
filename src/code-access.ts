import { assertProjectPath, type ResolvedOutput } from '@astra-spec/sdk';
import type { AnalysisIndex } from '@astra-spec/sdk';
import { PathExt } from '@jupyterlab/coreutils';
import type { Contents } from '@jupyterlab/services';
import { parse } from 'shell-quote';
import { projectDirectory } from './project-data';

export interface ICodeReference {
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
  // Reject substitution and line breaks up front: `parse` expands `$VAR`
  // silently and joins lines instead of failing.
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
  // Normalizing would fold an absolute path into a relative one.
  if (!candidate || /^\/|[{}~:]/.test(candidate)) return undefined;
  if (!/\.(py|r|js|mjs|cjs|sh)$/i.test(candidate)) return undefined;
  const relativePath = PathExt.normalize(candidate);
  try {
    assertProjectPath(relativePath);
  } catch {
    return undefined;
  }
  return relativePath;
}

/**
 * Locate the current working file named by a root-analysis output's recipe.
 *
 * `recordedCommand` is the recipe from a matching Lightcone run record; when
 * given it takes precedence over the declared recipe, since it is what
 * actually produced the artifact. Callers keep nested outputs out: the SDK
 * does not expose subanalysis working directories, so their scripts cannot
 * be located.
 */
export async function resolveOutputCode(
  contents: Contents.IManager,
  entrypoint: string,
  index: AnalysisIndex,
  output: ResolvedOutput,
  recordedCommand?: string
): Promise<ICodeReference | undefined> {
  const command = recordedCommand ?? output.recipe?.command;
  if (!command) return undefined;
  const inputSources = new Map<string, string>();
  for (const path of output.provenance.inputPaths) {
    const record = index.recordByPath.get(path);
    if (record?.kind === 'input' && record.source)
      inputSources.set(record.id, record.source);
  }
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
    relativePath,
    source: recordedCommand ? 'recorded run' : 'declared recipe'
  };
}
