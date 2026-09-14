import type { ResolvedOutput } from '@astra-spec/sdk';
import { PathExt } from '@jupyterlab/coreutils';
import type { Contents } from '@jupyterlab/services';
import { parse } from 'shell-quote';
import { projectDirectory, type ILoadedProjectData } from './project-data';

export interface ICodeReference {
  path: string;
  relativePath: string;
  source: 'recorded run' | 'declared recipe';
}

/** Recognize a direct script invocation without interpreting or running shell code. */
export function scriptFromCommand(command: string): string | undefined {
  if (/[\n\r`$]/.test(command)) return undefined;
  let tokens: ReturnType<typeof parse>;
  try {
    tokens = parse(command);
  } catch {
    return undefined;
  }
  if (!tokens.every((token): token is string => typeof token === 'string'))
    return undefined;
  const words = [...tokens];
  if (words[0] === 'uv' && words[1] === 'run') words.splice(0, 2);
  const executable = words[0] ?? '';
  let candidate: string | undefined;
  if (/^(python(?:\d+(?:\.\d+)*)?|Rscript|node|bash|sh)$/.test(executable)) {
    candidate = words[1];
  } else if (executable.startsWith('./')) {
    candidate = executable;
  }
  if (
    !candidate ||
    candidate.startsWith('-') ||
    /[{}~:$\\]/.test(candidate) ||
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
  let command = output.recipe?.command;
  let source: ICodeReference['source'] = 'declared recipe';
  const binding = data.bindings.find(
    item => item.outputPath === output.canonicalPath
  );
  if (binding) {
    const manifest = PathExt.join(
      PathExt.dirname(binding.path),
      `.${PathExt.basename(binding.path, PathExt.extname(binding.path))}.manifest.json`
    );
    try {
      const model = await contents.get(contents.resolvePath(root, manifest), {
        content: true,
        format: 'text',
        type: 'file'
      });
      const value: unknown =
        typeof model.content === 'string'
          ? JSON.parse(model.content)
          : undefined;
      if (
        value &&
        typeof value === 'object' &&
        'schema_version' in value &&
        value.schema_version === 1 &&
        'output_id' in value &&
        value.output_id === output.id &&
        'universe_id' in value &&
        value.universe_id === data.document.universe.universeId &&
        'recipe' in value &&
        typeof value.recipe === 'string'
      ) {
        command = value.recipe;
        source = 'recorded run';
      }
    } catch {
      // Manifests are optional Lightcone metadata; ASTRA recipes work without them.
    }
  }
  if (!command) return undefined;
  const relativePath = scriptFromCommand(command);
  if (!relativePath) return undefined;
  const path = contents.resolvePath(root, relativePath);
  try {
    const model = await contents.get(path, { content: false });
    if (model.type === 'file') return { path, relativePath, source };
  } catch {
    /* Missing scripts have no navigation action. */
  }
  return undefined;
}
