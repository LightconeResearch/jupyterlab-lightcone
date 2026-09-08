import { pdfJsWithWorker, type PdfJsLoader } from '@astra-spec/ui/lib';

/**
 * pdf.js for the shared paper viewer. The extension is bundled by rspack,
 * which only emits a worker referenced through `new Worker(new URL(...))`,
 * so the worker is created here and handed to the viewer's adapter, which
 * runs one per open document and terminates it with the document. The
 * legacy build and worker polyfill the viewer's browser floor together.
 */
export const loadPdfJs: PdfJsLoader = async () =>
  pdfJsWithWorker(
    await import('pdfjs-dist/legacy/build/pdf.mjs'),
    () =>
      new Worker(
        new URL('pdfjs-dist/legacy/build/pdf.worker.min.mjs', import.meta.url),
        { type: 'module' }
      )
  );
