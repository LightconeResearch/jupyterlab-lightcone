import { assertProjectPath, type ResolvedOutput } from '@astra-spec/sdk';
import type { AnalysisIndex } from '@astra-spec/sdk';
import { PathExt } from '@jupyterlab/coreutils';
import type { Contents } from '@jupyterlab/services';
import { parse } from 'shell-quote';
import { projectDirectory } from './project-data';

/** A project script an output's recipe names, and which recipe named it. */
export interface ICodeReference {
  /** Script location relative to the project directory. */
  relativePath: string;
  /** Whether the matching run record or the declaration supplied the recipe. */
  source: 'recorded run' | 'declared recipe';
}

/** Options to look past before the script, per launcher. */
interface ILauncherOptions {
  /** Options that take code or a module instead of a script file. */
  inline: RegExp;
  /** Options whose value is the following word. */
  valued: RegExp;
}

const UV_RUN: ILauncherOptions = {
  // `--directory` moves the working directory the script path is relative to.
  inline: /^(-m|--module|--directory)$/,
  valued:
    /^(-p|--python|--with|--with-editable|--with-requirements|--project|--extra|--group|--env-file|--index|--default-index)$/
};

const INTERPRETERS: ReadonlyArray<[RegExp, ILauncherOptions]> = [
  [
    /^python(?:\d+(?:\.\d+)*)?$/,
    { inline: /^-[A-Za-z]*[cm]$/, valued: /^-[WX]$/ }
  ],
  [/^Rscript$/, { inline: /^-e$/, valued: /^$/ }],
  [
    /^node$/,
    {
      inline: /^(-[ep]|--eval|--print)$/,
      valued: /^(-r|--require|--import)$/
    }
  ],
  [/^(bash|sh)$/, { inline: /^-[A-Za-z]*[cs]$/, valued: /^[-+][oO]$/ }]
];

/** Redirections, globs and comments leave a single command a single command. */
const HARMLESS_OPERATORS = new Set(['>', '>>', '<', '>&', 'glob']);

/**
 * Index of the first word after a launcher's options, or `undefined` when an
 * option replaces the script with inline code, a module or standard input.
 */
function skipOptions(
  words: readonly string[],
  start: number,
  options: ILauncherOptions
): number | undefined {
  let position = start;
  while (position < words.length && words[position].startsWith('-')) {
    const word = words[position];
    if (word === '-' || options.inline.test(word)) return undefined;
    if (word === '--') return position + 1;
    position += options.valued.test(word) ? 2 : 1;
  }
  return position;
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
  // Pipelines, lists, subshells and background jobs run more than one command.
  if (
    tokens.some(
      token =>
        typeof token !== 'string' &&
        'op' in token &&
        !HARMLESS_OPERATORS.has(token.op)
    )
  )
    return undefined;
  // The script has to precede any redirection, glob or comment.
  const operator = tokens.findIndex(token => typeof token !== 'string');
  const words = tokens
    .slice(0, operator < 0 ? undefined : operator)
    .filter((token): token is string => typeof token === 'string');
  let position: number | undefined = 0;
  if (words[0] === 'uv' && words[1] === 'run')
    position = skipOptions(words, 2, UV_RUN);
  if (position === undefined) return undefined;
  const executable = words[position] ?? '';
  let candidate: string | undefined;
  const interpreter = INTERPRETERS.find(([name]) => name.test(executable));
  if (interpreter) {
    const script = skipOptions(words, position + 1, interpreter[1]);
    candidate = script === undefined ? undefined : words[script];
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
  // An empty recorded recipe names nothing, the same as no record.
  const recorded = recordedCommand || undefined;
  const command = recorded ?? output.recipe?.command;
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
    source: recorded ? 'recorded run' : 'declared recipe'
  };
}
