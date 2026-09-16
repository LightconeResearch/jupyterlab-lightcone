import type { ResolvedOutput } from '@astra-spec/sdk';
import { PathExt } from '@jupyterlab/coreutils';
import type { Contents } from '@jupyterlab/services';
import { parse } from 'shell-quote';
import { projectDirectory, type ILoadedProjectData } from './project-data';
import { createJupyterProjectReader } from './project-reader';

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
  if (/[\n\r`$]/.test(command)) return undefined;
  let tokens: ReturnType<typeof parse>;
  try {
    tokens = parse(command);
  } catch {
    return undefined;
  }
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

/** Locate the current working file named by this output's recorded or declared recipe. */
export async function resolveOutputCode(
  contents: Contents.IManager,
  entrypoint: string,
  data: ILoadedProjectData,
  output: ResolvedOutput
): Promise<ICodeReference | undefined> {
  // The resolved SDK does not expose path-backed subanalysis working directories.
  // Until it does, do not guess which same-named script a nested recipe used.
  if (
    data.index.analysisByRecordPath.get(output.canonicalPath)?.canonicalPath !==
    '$'
  )
    return undefined;
  const root = projectDirectory(entrypoint);
  const reader = createJupyterProjectReader(contents, root);
  let command = output.recipe?.command;
  let source: ICodeReference['source'] = 'declared recipe';
  const binding = data.bindings.find(
    item => item.outputPath === output.canonicalPath
  );
  if (binding) {
    // Lightcone names the sidecar from the output id alone, never the
    // artifact's format: stripping one extension answers `x.tar` for `x.tar.gz`.
    const manifest = PathExt.join(
      PathExt.dirname(binding.path),
      `.${output.id}.manifest.json`
    );
    try {
      const { schema_version, output_id, universe_id, recipe } = JSON.parse(
        await reader.readText(manifest)
      ) as Record<string, unknown>;
      if (
        schema_version === 1 &&
        output_id === output.id &&
        universe_id === data.document.universe.universeId &&
        typeof recipe === 'string'
      ) {
        command = recipe;
        source = 'recorded run';
      }
    } catch {
      // Manifests are optional Lightcone metadata; ASTRA recipes work without them.
    }
  }
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
  try {
    if ((await reader.stat(relativePath))?.type !== 'file') return undefined;
  } catch {
    /* Unreadable locations have no navigation action. */
    return undefined;
  }
  return {
    path: contents.resolvePath(root, relativePath),
    relativePath,
    source
  };
}
