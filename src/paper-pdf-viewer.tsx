import type { PaperRenderOptions } from '@astra-spec/ui/components';
import type { InventoryPaper } from '@astra-spec/ui/model';
import type {
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  PDFWorker,
  RenderTask,
  TextLayer
} from 'pdfjs-dist';
import React, { useEffect, useRef, useState } from 'react';
import { findQuoteMatch, highlightMatch } from './pdf-quote';

type PdfJs = typeof import('pdfjs-dist');

interface IQuoteLocation {
  key: string;
  page: number;
  quote: string;
}

/** Render nearby pages only, preserving page geometry when canvases are released. */
function PdfPage({
  pdf,
  pdfjs,
  pageNumber,
  width,
  zoom,
  focus
}: {
  pdf: PDFDocumentProxy;
  pdfjs: PdfJs;
  pageNumber: number;
  width: number;
  zoom: number;
  focus?: IQuoteLocation;
}): React.ReactElement {
  const pageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const [nearby, setNearby] = useState(pageNumber === 1);
  const [aspectRatio, setAspectRatio] = useState(612 / 792);
  const [layer, setLayer] = useState<TextLayer>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    const node = pageRef.current;
    if (!node) {
      return;
    }
    const observer = new IntersectionObserver(
      entries => setNearby(entries.some(entry => entry.isIntersecting)),
      { root: node.parentElement, rootMargin: '600px' }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const active = nearby || focus !== undefined;
  useEffect(() => {
    if (!active || width === 0) {
      return;
    }
    let disposed = false;
    let renderTask: RenderTask | undefined;
    let textLayer: TextLayer | undefined;
    const canvas = canvasRef.current;
    const text = textRef.current;
    if (!canvas || !text) {
      return;
    }
    setLayer(undefined);
    setError(undefined);
    void (async () => {
      try {
        const page = await pdf.getPage(pageNumber);
        if (disposed) {
          return;
        }
        const base = page.getViewport({ scale: 1 });
        setAspectRatio(base.width / base.height);
        const viewport = page.getViewport({
          scale: (width * zoom) / base.width
        });
        const ratio = Math.min(window.devicePixelRatio || 1, 2);
        const context = canvas.getContext('2d');
        if (!context) {
          throw new Error('Canvas rendering is unavailable in this browser.');
        }
        canvas.width = Math.ceil(viewport.width * ratio);
        canvas.height = Math.ceil(viewport.height * ratio);
        text.replaceChildren();
        text.style.setProperty('--scale-factor', String(viewport.scale));
        renderTask = page.render({
          canvasContext: context,
          viewport,
          transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0]
        });
        await renderTask.promise;
        if (disposed) {
          return;
        }
        const content = await page.getTextContent();
        if (disposed) {
          return;
        }
        textLayer = new pdfjs.TextLayer({
          textContentSource: content,
          container: text,
          viewport
        });
        await textLayer.render();
        if (!disposed) {
          setLayer(textLayer);
        }
      } catch (reason) {
        if (!disposed) {
          setError(
            reason instanceof Error
              ? reason.message
              : 'The page could not be rendered.'
          );
        }
      }
    })();
    return () => {
      disposed = true;
      renderTask?.cancel();
      textLayer?.cancel();
      canvas.width = 0;
      canvas.height = 0;
      text.replaceChildren();
    };
  }, [active, pdf, pdfjs, pageNumber, width, zoom]);

  useEffect(() => {
    if (!layer) {
      return;
    }
    layer.textDivs.forEach((div, index) => {
      div.textContent = layer.textContentItemsStr[index];
    });
    if (focus) {
      const mark = highlightMatch(
        layer.textContentItemsStr,
        layer.textDivs,
        focus.quote
      );
      (mark ?? pageRef.current)?.scrollIntoView({ block: 'center' });
    }
  }, [focus, layer]);

  return (
    <div
      ref={pageRef}
      className="jp-jupyterlab-lightcone-pdf-page"
      data-page={pageNumber}
      aria-label={`Page ${pageNumber}`}
      style={{ width: width * zoom, aspectRatio }}
    >
      <canvas ref={canvasRef} aria-hidden="true" />
      <div ref={textRef} className="jp-jupyterlab-lightcone-pdf-text" />
      {error ? <p role="status">{error}</p> : null}
    </div>
  );
}

/** Continuous PDF reading with zoom and the active ASTRA evidence passage. */
export function JupyterPaperViewer({
  paper,
  options
}: {
  paper: InventoryPaper;
  options: PaperRenderOptions;
}): React.ReactElement {
  const [loaded, setLoaded] = useState<{
    pdf: PDFDocumentProxy;
    pdfjs: PdfJs;
  }>();
  const [status, setStatus] = useState('Loading PDF…');
  const [zoom, setZoom] = useState(1);
  const [width, setWidth] = useState(0);
  const [focus, setFocus] = useState<IQuoteLocation>();
  const scrollRef = useRef<HTMLDivElement>(null);
  const requested = options.focusEvidence;

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) {
      return;
    }
    const observer = new ResizeObserver(() =>
      setWidth(Math.max(100, node.clientWidth - 32))
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let disposed = false;
    let task: PDFDocumentLoadingTask | undefined;
    let worker: Worker | undefined;
    let pdfWorker: PDFWorker | undefined;
    setLoaded(undefined);
    setFocus(undefined);
    setStatus('Loading PDF…');
    void (async () => {
      try {
        if (!paper.pdfUrl) {
          throw new Error('No cached PDF is available.');
        }
        const pdfjs = await import('pdfjs-dist');
        if (disposed) {
          return;
        }
        worker = new Worker(
          new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url),
          { type: 'module' }
        );
        pdfWorker = pdfjs.PDFWorker.fromPort({ port: worker });
        task = pdfjs.getDocument({ url: paper.pdfUrl, worker: pdfWorker });
        const pdf = await task.promise;
        if (!disposed) {
          setLoaded({ pdf, pdfjs });
          setStatus(`${pdf.numPages} pages`);
        }
      } catch (reason) {
        if (!disposed) {
          setStatus(
            `The PDF could not be loaded: ${reason instanceof Error ? reason.message : 'Unknown error'}. Use Open PDF to view it directly.`
          );
        }
      }
    })();
    return () => {
      disposed = true;
      void (task?.destroy() ?? Promise.resolve())
        .catch(error =>
          console.warn('Could not release the PDF document.', error)
        )
        .finally(() => {
          pdfWorker?.destroy();
          worker?.terminate();
        });
    };
  }, [paper.pdfUrl]);

  useEffect(() => {
    setFocus(undefined);
    const quote = requested?.evidence.quote?.exact;
    if (!loaded || !requested || !quote) {
      return;
    }
    let disposed = false;
    const { pdf } = loaded;
    const citedPage = requested.evidence.location?.page;
    const pages = [
      ...new Set([
        ...(citedPage &&
        Number.isInteger(citedPage) &&
        citedPage <= pdf.numPages
          ? [citedPage]
          : []),
        ...Array.from({ length: pdf.numPages }, (_, index) => index + 1)
      ])
    ];
    void (async () => {
      setStatus('Locating quote in the PDF…');
      let partialPage: number | undefined;
      for (const pageNumber of pages) {
        if (disposed) {
          return;
        }
        try {
          const page = await pdf.getPage(pageNumber);
          const content = await page.getTextContent();
          if (disposed) {
            return;
          }
          const strings = content.items.flatMap(item =>
            'str' in item ? [item.str] : []
          );
          const match = findQuoteMatch(strings, quote);
          if (match?.complete) {
            setFocus({ key: requested.key, page: pageNumber, quote });
            setStatus(
              `Quote highlighted on page ${pageNumber} of ${pdf.numPages}`
            );
            return;
          }
          if (match) {
            partialPage ??= pageNumber;
          }
        } catch {
          // A page without extractable text does not prevent searching later pages.
        }
      }
      if (disposed) {
        return;
      }
      if (partialPage !== undefined) {
        setFocus({ key: requested.key, page: partialPage, quote });
        setStatus(
          `Partial quote highlighted on page ${partialPage} of ${pdf.numPages}`
        );
      } else if (citedPage && pages.includes(citedPage)) {
        setFocus({ key: requested.key, page: citedPage, quote });
        setStatus(
          `Exact quote not found; showing cited page ${citedPage} of ${pdf.numPages}`
        );
      } else {
        setStatus('The quoted passage was not found in the PDF text.');
      }
    })();
    return () => {
      disposed = true;
    };
  }, [loaded, requested]);

  return (
    <div
      className="jp-jupyterlab-lightcone-pdf"
      aria-label={`PDF viewer for ${paper.title}`}
    >
      <div className="jp-jupyterlab-lightcone-pdf-toolbar">
        <span role="status">{status}</span>
        <button
          type="button"
          disabled={!loaded || zoom <= 0.5}
          onClick={() => setZoom(value => value - 0.25)}
          aria-label="Zoom PDF out"
        >
          −
        </button>
        <span>{Math.round(zoom * 100)}%</span>
        <button
          type="button"
          disabled={!loaded || zoom >= 2}
          onClick={() => setZoom(value => value + 0.25)}
          aria-label="Zoom PDF in"
        >
          +
        </button>
        <a href={paper.pdfUrl} target="_blank" rel="noopener noreferrer">
          Open PDF ↗
        </a>
      </div>
      <div
        ref={scrollRef}
        className="jp-jupyterlab-lightcone-pdf-scroll"
        tabIndex={0}
        aria-label="PDF pages"
      >
        {loaded
          ? Array.from({ length: loaded.pdf.numPages }, (_, index) => (
              <PdfPage
                key={index}
                {...loaded}
                pageNumber={index + 1}
                width={width}
                zoom={zoom}
                focus={focus?.page === index + 1 ? focus : undefined}
              />
            ))
          : null}
      </div>
    </div>
  );
}
