/* eslint-disable @typescript-eslint/naming-convention -- Preserve the vendored upstream API. */
// Path-only subset from LightconeResearch/MySTRA, revision 8b7dd797. See MYSTRA-LICENSE.
// SDK 0.1.2 has canonical indexes but no authored-path parser.
// Remove once the SDK exports a browser-safe `parseAstraPath` (with its `AstraPath`
// type) and a canonical record path resolver.
/**
 * The unified ASTRA reference path grammar.
 *
 * A *path* is a dot-separated route through the analysis tree — the same
 * structure as `astra.yaml`, and the same dotted spelling the spec itself uses
 * for element references (`when: decision.option`, `from: scope.id`, recipe
 * placeholders `{inputs.id}`, and RFC-0002's `<sub>.<id>` addressing). Dots
 * address elements; slashes are reserved for files. Paths always resolve from
 * the root analysis:
 *
 *   outputs.hubble_diagram                    an output in the root analysis
 *   decisions.algorithm.gp                    a child (one Option of a Decision)
 *   decisions.algorithm.options.gp            … the explicit long form
 *   findings.sig.fig1                         a child (one Evidence of a Finding)
 *   reconstruction.outputs.xi                 a sub-analysis (the `analyses.` is implied)
 *   analyses.reconstruction.outputs.xi        … the explicit long form
 *   reconstruction                            the sub-analysis itself
 *   outputs                                   a whole collection (a registry)
 *
 * `parseAstraPath` turns the string into a structured {@link AstraPath}. One
 * grammar drives every surface: the `{astra}` role, the `{astra}` directive,
 * and the `{astra:*}` variants.
 */

/** The top-level ASTRA collections — exactly the keys of `astra.yaml`. */
export type Collection =
  | 'inputs'
  | 'outputs'
  | 'decisions'
  | 'findings'
  | 'prior_insights'
  | 'analyses';

/** Child collections that live *inside* an element. */
export type ChildCollection = 'options' | 'evidence';

const COLLECTIONS = new Set<string>([
  'inputs',
  'outputs',
  'decisions',
  'findings',
  'prior_insights',
  'analyses'
]);

const CHILD_COLLECTIONS = new Set<string>(['options', 'evidence']);

/**
 * The single child collection each element kind carries — what a bare segment
 * after `<collection>.<id>` addresses (`decisions.d.gp` ≡ `decisions.d.options.gp`).
 * Each kind has exactly one child collection, so the short form is unambiguous;
 * the explicit keyword stays accepted as the long form.
 */
const CHILD_BY_COLLECTION: Partial<Record<Collection, ChildCollection>> = {
  decisions: 'options',
  findings: 'evidence',
  prior_insights: 'evidence'
};

function isCollection(seg: string): seg is Collection {
  return COLLECTIONS.has(seg);
}

function isChildCollection(seg: string): seg is ChildCollection {
  return CHILD_COLLECTIONS.has(seg);
}

function canonicalCollection(seg: string): Collection | null {
  return isCollection(seg) ? seg : null;
}

export interface AstraPath {
  /** Sub-analysis ids walked into (the analysis path), innermost last. */
  scope: string[];
  /** The target collection; `null` only for an empty path. */
  collection: Collection | null;
  /** The element id; `null` when the path stops at a collection (a registry). */
  id: string | null;
  /** A child target inside the element (an option or an evidence record). */
  child: { collection: ChildCollection; id: string } | null;
}

/**
 * Return the SDK canonical path for the record addressed by an authored path.
 * Analysis paths are navigation targets rather than records; child
 * option/evidence paths resolve to their owning record.
 */
export function canonicalRecordPath(path: AstraPath): string | null {
  if (!path.collection || !path.id || path.collection === 'analyses') {
    return null;
  }
  return [...path.scope, path.collection, path.id].join('.');
}

/**
 * Parse a path string into a structured {@link AstraPath}.
 *
 * The dotted body is read left-to-right: each segment is either a *collection
 * keyword* (which begins the target) or a *sub-analysis step* (the `analyses.`
 * shorthand). The first non-`analyses` collection keyword fixes the target;
 * everything before it is scope. Malformed paths are rejected rather than
 * normalized into a different target.
 *
 * The parse is purely syntactic — it never checks the element exists. Callers
 * resolve {@link AstraPath} against a loaded analysis and report missing ids.
 */
export function parseAstraPath(raw: string): AstraPath {
  const value = (raw ?? '').trim();
  if (!value) return { scope: [], collection: null, id: null, child: null };
  if (value.startsWith('/')) {
    throw new Error('ASTRA paths must not start with "/"');
  }
  const segs = value.split('.');
  if (segs.some(segment => !segment || segment !== segment.trim())) {
    throw new Error(`invalid ASTRA path "${raw}"`);
  }
  if (segs.includes('prior-insights')) {
    throw new Error('use the canonical collection name "prior_insights"');
  }
  if (segs.includes('universes')) {
    throw new Error('universes are resolution inputs, not addressable records');
  }

  const scope: string[] = [];
  let collection: Collection | null = null;
  let id: string | null = null;
  let child: AstraPath['child'] = null;

  let i = 0;
  while (i < segs.length) {
    const seg = segs[i];
    const col = canonicalCollection(seg);

    if (col === 'analyses') {
      // `analyses.<sub>` is a scope step (the sub becomes the target only when
      // it's the final segment); a trailing bare `analyses` is the registry.
      if (i + 1 < segs.length) {
        const analysisId = segs[i + 1];
        if (
          canonicalCollection(analysisId) ||
          CHILD_COLLECTIONS.has(analysisId)
        ) {
          throw new Error(`missing analysis id after "analyses" in "${raw}"`);
        }
        if (i + 2 === segs.length) {
          collection = 'analyses';
          id = analysisId;
          i = segs.length;
          break;
        }
        scope.push(analysisId);
        i += 2;
        continue;
      }
      collection = 'analyses';
      break;
    }

    if (col) {
      collection = col;
      i++;
      if (i < segs.length) {
        id = segs[i];
        i++;
      }
      if (i < segs.length) {
        const expectedChild = CHILD_BY_COLLECTION[collection];
        if (!expectedChild) {
          throw new Error(
            `unexpected segment "${segs[i]}" after ${collection}.${id}`
          );
        }
        const next = segs[i];
        if (isChildCollection(next)) {
          // Explicit long form: `…options.<id>` / `…evidence.<id>`.
          const cid = segs[i + 1];
          if (next !== expectedChild) {
            throw new Error(
              `${collection}.${id} has "${expectedChild}", not "${next}"`
            );
          }
          if (!cid) throw new Error(`missing ${next} id in "${raw}"`);
          if (i + 2 !== segs.length) {
            throw new Error(`unexpected segment "${segs[i + 2]}" in "${raw}"`);
          }
          child = { collection: next, id: cid };
        } else {
          // Short form: the child collection is implied by the parent kind.
          if (i + 1 !== segs.length) {
            throw new Error(`unexpected segment "${segs[i + 1]}" in "${raw}"`);
          }
          child = { collection: expectedChild, id: next };
        }
      }
      break;
    }

    // Not a collection keyword → a sub-analysis step (the `analyses.` shorthand).
    scope.push(seg);
    i++;
  }

  // A path that ends on a bare sub-analysis step targets that sub-analysis:
  // normalize to the explicit `analyses.<id>` form so every consumer sees one
  // shape instead of special-casing `collection: null`.
  if (!collection) {
    const last = scope.pop();
    if (last !== undefined) {
      collection = 'analyses';
      id = last;
    }
  }

  return { scope, collection, id, child };
}
