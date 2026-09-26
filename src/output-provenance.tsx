import type {
  AnalysisIndex,
  ResolvedOutput,
  ResolvedRecord
} from '@astra-spec/sdk';
import type { OutputRun, OutputStatus } from '@astra-spec/ui/model';
import { showErrorMessage } from '@jupyterlab/apputils';
import type { Contents } from '@jupyterlab/services';
import React, { useEffect, useMemo, useState } from 'react';
import { fetchRunRecord } from './api';
import type { IDocumentOpener } from './artifact-access';
import {
  resolveOutputCode,
  scriptFromCommand,
  type ICodeReference
} from './code-access';
import { isRootAnalysisOutput } from './materialization-status';
import { projectDirectory } from './project-data';
import {
  ProvenanceTabs,
  recordedRevision,
  type IProvenanceCode,
  type IProvenanceInput,
  type IProvenancePackages
} from './versions/provenance-tabs';
import { runView } from './versions/version-model';
import {
  fetchLockedPackages,
  fetchRevisionSource,
  type IOutputVersion
} from './versions/versions-api';

/**
 * The record behind one of a run's input versions. The engine keys them by
 * the ids the output lists under `inputs:`, which the SDK resolves in the same
 * order into `provenance.inputPaths`: a sibling output wins over an input of
 * the same id, a `sub.output` id names a sub-analysis's output, and an alias
 * resolves to its target. So an upstream output is found as the output it is,
 * as the record's own "Inputs and upstream outputs" list shows it. An id the
 * output no longer lists is looked up among its analysis's outputs, then its
 * inputs; undefined when it names neither.
 */
export function runInputRecord(
  index: AnalysisIndex,
  output: ResolvedOutput,
  id: string
): ResolvedRecord | undefined {
  const declared = output.inputs ?? [];
  const paths = output.provenance.inputPaths;
  const position = declared.indexOf(id);
  if (position >= 0 && declared.length === paths.length) {
    const record = index.recordByPath.get(paths[position]);
    if (record) return record;
  }
  const analysis = index.analysisByRecordPath.get(output.canonicalPath);
  return (
    analysis?.outputs.find(candidate => candidate.id === id) ??
    analysis?.inputs.find(candidate => candidate.id === id)
  );
}

export interface IJupyterOutputProvenanceProps {
  contents: Contents.IManager;
  entrypoint: string;
  index: AnalysisIndex;
  universe: string;
  output: ResolvedOutput;
  status: OutputStatus | undefined;
  /**
   * The committed version whose run to describe. Undefined describes the
   * current sidecar only, as the inventory does.
   */
  version?: IOutputVersion;
  /** Opens a record the run depends on in the host's record view. */
  onOpenRecord?: (record: ResolvedRecord) => void;
  /** Lets the Code tab open the script in a document tab. */
  documents?: IDocumentOpener;
  /** Dismiss a host dialog before the document manager activates its file. */
  beforeOpenDocument?: () => void;
}

/** Mounted only for the open output detail; never reads every output's record. */
export function JupyterOutputProvenance({
  contents,
  entrypoint,
  index,
  universe,
  output,
  status,
  version,
  onOpenRecord,
  documents,
  beforeOpenDocument
}: IJupyterOutputProvenanceProps): React.ReactElement {
  const [result, setResult] = useState<{
    record?: OutputRun | null;
    error?: string;
  }>();
  const state = status?.state;
  const detail = status?.detail;
  useEffect(() => {
    let active = true;
    if (version) {
      setResult(undefined);
      return;
    }
    if (
      !isRootAnalysisOutput(index, output) ||
      contents.driveName(entrypoint)
    ) {
      setResult({
        error: 'Run records require an output in a local root analysis.'
      });
      return;
    }
    setResult(undefined);
    // A refreshed output can represent a new run even when its status is
    // unchanged, and a changed status always can, so both start a fresh read.
    fetchRunRecord(
      contents.serverSettings,
      entrypoint,
      universe,
      output,
      state ? { state, detail } : undefined
    ).then(
      record => {
        if (active) setResult({ record });
      },
      reason => {
        if (active)
          setResult({
            error: reason instanceof Error ? reason.message : String(reason)
          });
      }
    );
    // Ignoring a superseded response is what keeps it from landing.
    return () => {
      active = false;
    };
  }, [contents, entrypoint, index, universe, output, state, detail, version]);

  // A version knows its own run; the sidecar only describes the current one.
  const view = useMemo(() => {
    if (version) return runView(undefined, version);
    if (result?.record === undefined) return undefined;
    return result.record === null ? null : runView(result.record, undefined);
  }, [result, version]);

  // The manifest's recipe names the script.
  const recipe = view?.recipe;
  const [code, setCode] = useState<ICodeReference>();
  useEffect(() => {
    let active = true;
    setCode(undefined);
    if (!isRootAnalysisOutput(index, output) || (version && !recipe)) return;
    void resolveOutputCode(contents, entrypoint, index, output, recipe).then(
      reference => {
        if (active) setCode(reference);
      },
      () => {
        if (active) setCode(undefined);
      }
    );
    return () => {
      active = false;
    };
  }, [contents, entrypoint, index, output, recipe, version]);

  const inputs = useMemo<IProvenanceInput[]>(() => {
    if (!view) return [];
    return Object.entries(view.inputVersions).map(([id, inputVersion]) => {
      const record = runInputRecord(index, output, id);
      return {
        id,
        version: inputVersion,
        record,
        onOpen: record && onOpenRecord ? () => onOpenRecord(record) : undefined
      };
    });
  }, [view, index, output, onOpenRecord]);

  // The script as the run executed it, beside the file today: read once the
  // Code tab is shown, from the revision the run recorded.
  const revision = recordedRevision(view);
  // A run's expanded recipe names its historical file even after deletion.
  // Current-file lookup controls navigation, not whether Git can be read.
  const recordedPath = recipe ? scriptFromCommand(recipe) : undefined;
  const scriptPath = recordedPath ?? code?.relativePath;
  const shownCode: ICodeReference | undefined =
    code ??
    (recordedPath
      ? { relativePath: recordedPath, source: 'recorded run' }
      : undefined);
  const [recordedCode, setRecordedCode] = useState<IProvenanceCode>();
  const [wantCode, setWantCode] = useState(false);
  useEffect(() => {
    if (!wantCode || !revision || !scriptPath) return;
    let active = true;
    setRecordedCode({ loading: true });
    const current = contents
      .get(contents.resolvePath(projectDirectory(entrypoint), scriptPath), {
        content: true,
        type: 'file',
        format: 'text'
      })
      .then(
        model => (typeof model.content === 'string' ? model.content : null),
        () => null
      );
    Promise.all([
      fetchRevisionSource(
        contents.serverSettings,
        entrypoint,
        revision,
        scriptPath
      ),
      current
    ]).then(
      ([source, text]) => {
        if (active) setRecordedCode({ loading: false, source, current: text });
      },
      reason => {
        if (active)
          setRecordedCode({
            loading: false,
            error: reason instanceof Error ? reason.message : String(reason)
          });
      }
    );
    return () => {
      active = false;
    };
  }, [wantCode, revision, scriptPath, contents, entrypoint]);

  // The environment the run was locked to, read once the Environment tab is shown.
  const [packages, setPackages] = useState<IProvenancePackages>();
  const [wantPackages, setWantPackages] = useState(false);
  useEffect(() => {
    if (!wantPackages || !revision) return;
    let active = true;
    setPackages({ loading: true });
    fetchLockedPackages(contents.serverSettings, entrypoint, revision).then(
      locked => {
        if (active) setPackages({ loading: false, locked });
      },
      reason => {
        if (active)
          setPackages({
            loading: false,
            error: reason instanceof Error ? reason.message : String(reason)
          });
      }
    );
    return () => {
      active = false;
    };
  }, [wantPackages, revision, contents, entrypoint]);

  const openCode =
    documents && code
      ? (relativePath: string) => {
          const path = contents.resolvePath(
            projectDirectory(entrypoint),
            relativePath
          );
          try {
            beforeOpenDocument?.();
            if (!documents.openOrReveal(path, 'Editor')) {
              throw new Error(`No document viewer can open ${path}.`);
            }
          } catch (reason) {
            void showErrorMessage('Could not open code', String(reason));
          }
        }
      : undefined;

  return (
    <ProvenanceTabs
      status={status}
      run={view}
      error={version ? undefined : result?.error}
      code={shownCode}
      onOpenCode={openCode}
      inputs={inputs}
      recordedCode={recordedCode}
      onShowCode={() => setWantCode(true)}
      packages={packages}
      onShowEnvironment={() => setWantPackages(true)}
    />
  );
}
