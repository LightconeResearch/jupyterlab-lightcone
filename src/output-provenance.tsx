import type {
  AnalysisIndex,
  ResolvedOutput,
  ResolvedRecord
} from '@astra-spec/sdk';
import type { OutputRun, OutputStatus } from '@astra-spec/ui/model';
import { showErrorMessage } from '@jupyterlab/apputils';
import type { Contents } from '@jupyterlab/services';
import type { CommandRegistry } from '@lumino/commands';
import React, { useEffect, useMemo, useState } from 'react';
import { fetchRunRecord } from './api';
import { resolveOutputCode, type ICodeReference } from './code-access';
import { isRootAnalysisOutput } from './materialization-status';
import { projectDirectory } from './project-data';
import { listSessions, type ISessionInfo } from './sessions/sessions-api';
import {
  ProvenanceTabs,
  type IProvenanceInput,
  type IProvenanceSessions
} from './versions/provenance-tabs';
import { runView, sessionsActiveAround } from './versions/version-model';
import type { IOutputVersion } from './versions/versions-api';

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
  /** Lets the Code and Conversation tabs open files and sessions. */
  commands?: CommandRegistry;
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
  commands
}: IJupyterOutputProvenanceProps): React.ReactElement {
  const [result, setResult] = useState<{
    record?: OutputRun | null;
    error?: string;
  }>();
  const state = status?.state;
  const detail = status?.detail;
  useEffect(() => {
    let active = true;
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
  }, [contents, entrypoint, index, universe, output, state, detail]);

  // A version knows its own run; the sidecar only describes the current one.
  const view = useMemo(() => {
    if (version) return runView(result?.record, version);
    if (result?.record === undefined) return undefined;
    return result.record === null ? null : runView(result.record, undefined);
  }, [result, version]);

  const command = view?.command;
  const [code, setCode] = useState<ICodeReference>();
  useEffect(() => {
    let active = true;
    setCode(undefined);
    if (!isRootAnalysisOutput(index, output)) return;
    void resolveOutputCode(contents, entrypoint, index, output, command).then(
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
  }, [contents, entrypoint, index, output, command]);

  const inputs = useMemo<IProvenanceInput[]>(() => {
    if (!view) return [];
    const analysis = index.analysisByRecordPath.get(output.canonicalPath);
    return Object.entries(view.inputVersions).map(([id, inputVersion]) => {
      const record = analysis?.inputs.find(input => input.id === id);
      return {
        id,
        version: inputVersion,
        record,
        onOpen: record && onOpenRecord ? () => onOpenRecord(record) : undefined
      };
    });
  }, [view, index, output, onOpenRecord]);

  const runTime = view?.time;
  const [sessions, setSessions] = useState<IProvenanceSessions>();
  const [wantSessions, setWantSessions] = useState(false);
  useEffect(() => {
    if (!wantSessions || !runTime) return;
    let active = true;
    setSessions({ loading: true, items: [], total: 0 });
    listSessions(contents.serverSettings, entrypoint).then(
      listing => {
        if (!active) return;
        const items: ISessionInfo[] = sessionsActiveAround(
          listing.sessions,
          runTime
        );
        setSessions({
          loading: false,
          items,
          total: listing.sessions.length
        });
      },
      reason => {
        if (active)
          setSessions({
            loading: false,
            items: [],
            total: 0,
            error: reason instanceof Error ? reason.message : String(reason)
          });
      }
    );
    return () => {
      active = false;
    };
  }, [wantSessions, runTime, contents, entrypoint]);

  const openDocument = commands
    ? (path: string, factory: string, subject: string) => {
        void commands
          .execute('docmanager:open', { path, factory })
          .catch(reason =>
            showErrorMessage(`Could not open ${subject}`, String(reason))
          );
      }
    : undefined;

  return (
    <ProvenanceTabs
      status={status}
      run={view}
      error={result?.error}
      code={code}
      onOpenCode={
        openDocument
          ? relativePath =>
              openDocument(
                contents.resolvePath(
                  projectDirectory(entrypoint),
                  relativePath
                ),
                'Editor',
                'code'
              )
          : undefined
      }
      inputs={inputs}
      sessions={sessions}
      onOpenSession={
        openDocument ? path => openDocument(path, 'Chat', 'session') : undefined
      }
      onShowConversation={() => setWantSessions(true)}
    />
  );
}
