import type {
  AnalysisIndex,
  ResolvedOutput,
  ResolvedRecord
} from '@astra-spec/sdk';
import type { OutputRun, OutputStatus } from '@astra-spec/ui/model';
import { showErrorMessage } from '@jupyterlab/apputils';
import type { Contents } from '@jupyterlab/services';
import type { CommandRegistry } from '@lumino/commands';
import type { ReadonlyPartialJSONObject } from '@lumino/coreutils';
import React, { useEffect, useMemo, useState } from 'react';
import { fetchRunRecord } from './api';
import { resolveOutputCode, type ICodeReference } from './code-access';
import { isRootAnalysisOutput } from './materialization-status';
import { projectDirectory } from './project-data';
import { listSessions, type ISessionInfo } from './sessions/sessions-api';
import {
  ProvenanceTabs,
  recordedRevision,
  type IProvenanceCode,
  type IProvenanceInput,
  type IProvenancePackages,
  type IProvenanceSessions
} from './versions/provenance-tabs';
import { runView, sessionsActiveAround } from './versions/version-model';
import {
  fetchLockedPackages,
  fetchRevisionSource,
  type IOutputVersion
} from './versions/versions-api';

/**
 * `SessionsCommandIDs.openSession`, named here rather than imported so that
 * record views do not load the sessions plugin module and Jupyter Chat.
 */
const OPEN_SESSION_COMMAND = 'jupyterlab_lightcone:open-session';

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
    if (version) return runView(undefined, version);
    if (result?.record === undefined) return undefined;
    return result.record === null ? null : runView(result.record, undefined);
  }, [result, version]);

  // The recipe names the script; the DataLad command only starts the worker.
  const recipe = view?.recipe;
  const [code, setCode] = useState<ICodeReference>();
  useEffect(() => {
    let active = true;
    setCode(undefined);
    if (!isRootAnalysisOutput(index, output)) return;
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
  }, [contents, entrypoint, index, output, recipe]);

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

  // The script as the run executed it, beside the file today: read once the
  // Code tab is shown, from the revision the run recorded.
  const revision = recordedRevision(view);
  const scriptPath = code?.relativePath;
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

  const openWith = commands
    ? (command: string, args: ReadonlyPartialJSONObject, subject: string) => {
        void commands
          .execute(command, args)
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
        openWith
          ? relativePath =>
              openWith(
                'docmanager:open',
                {
                  path: contents.resolvePath(
                    projectDirectory(entrypoint),
                    relativePath
                  ),
                  factory: 'Editor'
                },
                'code'
              )
          : undefined
      }
      inputs={inputs}
      sessions={sessions}
      onOpenSession={
        // The sessions service places the chat where every other entry point
        // does, beside the results rather than among them.
        openWith && commands?.hasCommand(OPEN_SESSION_COMMAND)
          ? path => openWith(OPEN_SESSION_COMMAND, { path }, 'session')
          : undefined
      }
      onShowConversation={() => setWantSessions(true)}
      recordedCode={recordedCode}
      onShowCode={() => setWantCode(true)}
      packages={packages}
      onShowEnvironment={() => setWantPackages(true)}
    />
  );
}
