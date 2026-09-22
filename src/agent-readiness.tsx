import { Clipboard } from '@jupyterlab/apputils';
import type { ServerConnection } from '@jupyterlab/services';
import type { TranslationBundle } from '@jupyterlab/translation';
import React, { useCallback, useEffect, useState } from 'react';
import { fetchAgentReadiness, type IAgentReadiness } from './api';

interface IAgentReadinessProps {
  settings: ServerConnection.ISettings;
  trans: TranslationBundle;
}

const CLASS = 'jp-jupyterlab-lightcone-TourAgents';

/**
 * The tour step that checks which coding agents this server can run.
 *
 * Jupyter AI silently leaves out an agent whose adapter is missing, so the
 * check names each adapter, says whether it is on the server's PATH, and gives
 * the install command to run where JupyterLab runs.
 */
export function AgentReadiness({
  settings,
  trans
}: IAgentReadinessProps): JSX.Element {
  const [report, setReport] = useState<IAgentReadiness>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const check = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      setReport(await fetchAgentReadiness(settings));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }, [settings]);
  useEffect(() => {
    void check();
  }, [check]);
  const missing = report?.agents.filter(agent => !agent.installed) ?? [];
  const offered = report?.agents.some(agent => agent.offered) ?? true;
  return (
    <div className={CLASS}>
      {!report && !error && (
        <p>{trans.__('Checking this server for agent adapters…')}</p>
      )}
      {error && <p className={`${CLASS}-error`}>{error}</p>}
      {report && (
        <ul>
          {report.agents.map(agent => (
            <li
              key={agent.id}
              className={`${CLASS}-${agent.installed ? 'ready' : 'missing'}`}
            >
              <strong>{agent.name}</strong>
              <span className={`${CLASS}-state`}>
                {agent.installed
                  ? trans.__('ready')
                  : trans.__('not installed')}
              </span>
              {!agent.installed && (
                <div className={`${CLASS}-install`}>
                  <code>{agent.install}</code>
                  <button
                    type="button"
                    title={trans.__('Copy the install command')}
                    onClick={() => Clipboard.copyToSystem(agent.install)}
                  >
                    {trans.__('Copy')}
                  </button>
                </div>
              )}
              <small>
                {trans.__('Sign in on the server with %1.', agent.login)}
              </small>
            </li>
          ))}
        </ul>
      )}
      {report && !offered && (
        <p>
          {trans.__(
            "Jupyter AI's ACP client is not installed, so no agent can be offered. Install jupyter-ai-acp-client where JupyterLab runs."
          )}
        </p>
      )}
      {report && !report.npm && missing.length > 0 && (
        <p>
          {trans.__(
            'Node.js 22 or later with npm is needed first; in a conda environment, run conda install nodejs.'
          )}
        </p>
      )}
      {report && missing.length > 0 && (
        <p>
          {trans.__(
            'After installing an adapter, restart the Jupyter server or send /refresh-personas in a chat so that Jupyter AI offers it.'
          )}
        </p>
      )}
      <button type="button" disabled={busy} onClick={() => void check()}>
        {busy ? trans.__('Checking…') : trans.__('Check again')}
      </button>
    </div>
  );
}
