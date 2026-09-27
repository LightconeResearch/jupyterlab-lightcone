import {
  renderMarkdown,
  RenderMimeRegistry,
  type IRenderMimeRegistry
} from '@jupyterlab/rendermime';
import type { Contents } from '@jupyterlab/services';
import React, { useEffect, useRef } from 'react';

interface IDescriptionMarkdownProps {
  source: string;
  rendermime: IRenderMimeRegistry;
  contents: Contents.IManager;
  path: string;
}

/** Render project Markdown with JupyterLab's sanitizer and project-relative links. */
export function DescriptionMarkdown({
  source,
  rendermime,
  contents,
  path
}: IDescriptionMarkdownProps): React.ReactElement {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = document.createElement('div');
    host.className = 'jp-RenderedHTMLCommon jp-RenderedMarkdown';
    host.textContent = source;
    container.current?.appendChild(host);
    let active = true;
    void renderMarkdown({
      host,
      source,
      trusted: false,
      sanitizer: rendermime.sanitizer,
      markdownParser: rendermime.markdownParser,
      latexTypesetter: rendermime.latexTypesetter,
      shouldTypeset: true,
      resolver: new RenderMimeRegistry.UrlResolver({ path, contents }),
      linkHandler: rendermime.linkHandler
    }).catch(error => {
      if (active) {
        console.warn('Could not render the project description.', error);
        host.textContent = source;
        host.style.whiteSpace = 'pre-wrap';
      }
    });
    // Each revision has its own node, so a late render cannot replace newer text.
    return () => {
      active = false;
      host.remove();
    };
  }, [source, rendermime, contents, path]);
  return (
    <div
      className="jp-jupyterlab-lightcone-Home-descriptionMarkdown"
      ref={container}
    />
  );
}
