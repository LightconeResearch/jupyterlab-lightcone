import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { MessagePreambleProps } from '@jupyter/chat';
import type { JupyterFrontEnd } from '@jupyterlab/application';
import { showErrorMessage, type IThemeManager } from '@jupyterlab/apputils';
import { RecordPreview } from '@astra-spec/ui/components';
import { PreviewPopover, surfaceGlyph } from '@astra-spec/ui/primitives';
import { recordTitle } from '@astra-spec/ui/model';
import {
  astraRoles,
  mountRoles,
  type IAstraRole,
  type IRoleMount
} from './chat-markdown';
import { contextForChat, type IChatContext } from './chat-context';
import { resolveElement } from './element-reference';
import { useProject } from './element-widget';
import { useProjectRenderers } from './project-renderers';
import { CommandIDs } from './commands';
import { LightconeThemeBinding } from './theme-adapter';

function Reference({
  role,
  context,
  app,
  themes
}: {
  role: IAstraRole;
  context: IChatContext;
  app: JupyterFrontEnd;
  themes: IThemeManager;
}): React.ReactElement {
  const state = useProject(app.serviceManager.contents, context);
  const [open, setOpen] = useState(false);
  const [scheme, setScheme] = useState<'light' | 'dark'>(
    themes.isLight(themes.theme ?? '') ? 'light' : 'dark'
  );
  useEffect(() => {
    const update = () =>
      setScheme(themes.isLight(themes.theme ?? '') ? 'light' : 'dark');
    themes.themeChanged.connect(update);
    return () => {
      themes.themeChanged.disconnect(update);
    };
  }, [themes]);
  let resolved: ReturnType<typeof resolveElement> | undefined;
  let error = state.error;
  try {
    if (state.data) resolved = resolveElement(state.data, role.target);
  } catch (reason) {
    error = String(reason);
  }
  const kind = resolved?.record?.kind ?? 'analysis';
  const label =
    role.display ??
    (resolved?.record
      ? recordTitle(resolved.record)
      : resolved?.analysis.name) ??
    role.target;
  const navigate = (target: string) => {
    void app.commands
      .execute(CommandIDs.openElement, { ...context, target })
      .catch(reason =>
        showErrorMessage('Could not open ASTRA element', reason)
      );
  };
  return (
    <PreviewPopover
      label={label}
      kind={kind}
      open={open}
      onOpenChange={setOpen}
      portalProps={{
        className: 'lightcone-brand jp-jupyterlab-lightcone-preview',
        'data-astra-color-scheme': scheme,
        'data-lightcone-color-scheme': scheme
      }}
      trigger={
        <button
          type="button"
          className="jp-jupyterlab-lightcone-reference-button"
          onClick={() => navigate(role.target)}
          aria-label={`Open ${label}`}
        >
          <span aria-hidden="true">{surfaceGlyph(kind)}</span> {label}
        </button>
      }
    >
      {open && (
        <>
          {error && <p role="status">{error}</p>}
          {resolved && state.data ? (
            <PreviewBody
              app={app}
              context={context}
              state={state}
              resolved={resolved}
              navigate={navigate}
            />
          ) : (
            <p>
              {error
                ? 'This reference is unavailable.'
                : 'Loading ASTRA preview…'}
            </p>
          )}
          <small>
            {context.entrypoint} · {context.universeId ?? 'defaults'} ·{' '}
            {role.target}
          </small>
        </>
      )}
    </PreviewPopover>
  );
}

function PreviewBody({
  app,
  context,
  state,
  resolved,
  navigate
}: {
  app: JupyterFrontEnd;
  context: IChatContext;
  state: ReturnType<typeof useProject>;
  resolved: ReturnType<typeof resolveElement>;
  navigate: (target: string) => void;
}): React.ReactElement | null {
  const data = state.data!;
  const renderers = useProjectRenderers(
    app.serviceManager.contents,
    context.entrypoint,
    data,
    state.fetchPaper
  );
  return (
    <RecordPreview
      entry={
        resolved.record
          ? {
              kind: 'record',
              record: resolved.record,
              analysis: resolved.analysis
            }
          : { kind: 'analysis', analysis: resolved.analysis }
      }
      document={data.document}
      index={data.index}
      renderArtifact={renderers.renderArtifact}
      onOpenRecord={record => navigate(record.canonicalPath)}
      onOpenAnalysis={() =>
        navigate(resolved.target === '$' ? '' : resolved.target)
      }
    />
  );
}

/** The preamble provides a public lifecycle; the DOM adapter is intentionally confined to one message. */
export function ChatPreview({
  model,
  message,
  app,
  themes
}: MessagePreambleProps & {
  app: JupyterFrontEnd;
  themes: IThemeManager;
}): React.ReactElement {
  const anchor = useRef<HTMLSpanElement>(null);
  const [mounts, setMounts] = useState<IRoleMount[]>([]);
  const [, updateContext] = useState(0);
  useEffect(() => {
    const update = () => updateContext(value => value + 1);
    model.messagesUpdated.connect(update);
    return () => {
      model.messagesUpdated.disconnect(update);
    };
  }, [model]);
  let context: IChatContext | undefined;
  try {
    context = contextForChat(model);
  } catch {
    /* Conflicting histories remain plain Markdown. */
  }
  useEffect(() => {
    const container = anchor.current?.closest<HTMLElement>('.jp-chat-message');
    if (!container || !context || message.mime_model || message.deleted) return;
    const roles = astraRoles(message.body);
    let mounted: IRoleMount[] = [];
    let bindings: LightconeThemeBinding[] = [];
    const decorate = () => {
      const root = container.querySelector<HTMLElement>(
        '.jp-chat-rendered-message'
      );
      if (
        !root ||
        (mounted.length && mounted.every(item => root.contains(item.node)))
      )
        return;
      mounted.forEach(item => item.restore());
      bindings.forEach(binding => binding.dispose());
      mounted = mountRoles(root, roles);
      bindings = mounted.map(item => {
        item.node.classList.add('astra-ui', 'lightcone-brand');
        return new LightconeThemeBinding(themes, item.node);
      });
      observer.takeRecords();
      setMounts(mounted);
    };
    const observer = new MutationObserver(decorate);
    observer.observe(container, {
      childList: true,
      subtree: true,
      characterData: true
    });
    decorate();
    return () => {
      observer.disconnect();
      bindings.forEach(binding => binding.dispose());
      mounted.forEach(item => item.restore());
      setMounts([]);
    };
  }, [
    message.body,
    message.mime_model,
    message.deleted,
    context?.entrypoint,
    context?.universeId,
    themes
  ]);
  return (
    <>
      <span ref={anchor} hidden />
      {context &&
        mounts.map((item, i) =>
          createPortal(
            <Reference
              role={item.role}
              context={context}
              app={app}
              themes={themes}
            />,
            item.node,
            String(i)
          )
        )}
    </>
  );
}
