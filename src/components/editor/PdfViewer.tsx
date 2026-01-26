// ABOUTME: PDF viewer component for displaying PDF files.
// ABOUTME: Uses pdf.js for rendering with page navigation and zoom controls.

import * as pdfjsLib from "pdfjs-dist";
import {
  type Component,
  createEffect,
  createSignal,
  onCleanup,
} from "solid-js";

// Set up the worker
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url,
).toString();

interface PdfViewerProps {
  filePath: string;
}

export const PdfViewer: Component<PdfViewerProps> = (props) => {
  const [currentPage, setCurrentPage] = createSignal(1);
  const [totalPages, setTotalPages] = createSignal(0);
  const [zoom, setZoom] = createSignal(100);
  const [error, setError] = createSignal<string | null>(null);
  const [isLoading, setIsLoading] = createSignal(true);

  let canvasRef: HTMLCanvasElement | undefined;
  let pdfDoc: pdfjsLib.PDFDocumentProxy | null = null;
  let currentRenderTask: pdfjsLib.RenderTask | null = null;

  // Load PDF when file path changes
  createEffect(() => {
    const path = props.filePath;
    if (!path) return;

    loadPdf(path);
  });

  onCleanup(() => {
    if (currentRenderTask) {
      currentRenderTask.cancel();
    }
    if (pdfDoc) {
      pdfDoc.destroy();
    }
  });

  async function loadPdf(path: string) {
    setIsLoading(true);
    setError(null);

    try {
      // Clean up previous document
      if (pdfDoc) {
        pdfDoc.destroy();
        pdfDoc = null;
      }

      // Load PDF using file:// URL
      const url = `file://${path}`;
      const loadingTask = pdfjsLib.getDocument(url);
      pdfDoc = await loadingTask.promise;

      setTotalPages(pdfDoc.numPages);
      setCurrentPage(1);
      setIsLoading(false);

      // Render first page
      await renderPage(1);
    } catch (err) {
      console.error("Failed to load PDF:", err);
      setError("Failed to load PDF file");
      setIsLoading(false);
    }
  }

  async function renderPage(pageNum: number) {
    if (!pdfDoc || !canvasRef) return;

    try {
      // Cancel any ongoing render
      if (currentRenderTask) {
        currentRenderTask.cancel();
        currentRenderTask = null;
      }

      const page = await pdfDoc.getPage(pageNum);
      const scale = zoom() / 100;
      const viewport = page.getViewport({ scale });

      // Set canvas dimensions
      const canvas = canvasRef;
      const context = canvas.getContext("2d");
      if (!context) return;

      canvas.height = viewport.height;
      canvas.width = viewport.width;

      // Render page
      const renderContext = {
        canvasContext: context,
        viewport: viewport,
        canvas: canvas,
      };

      currentRenderTask = page.render(renderContext);
      await currentRenderTask.promise;
      currentRenderTask = null;
    } catch (err: unknown) {
      // Ignore cancelled render errors
      if (err instanceof Error && err.message !== "Rendering cancelled") {
        console.error("Failed to render page:", err);
      }
    }
  }

  // Re-render when page or zoom changes
  createEffect(() => {
    const page = currentPage();
    void zoom(); // Track zoom changes for reactivity
    if (pdfDoc && page > 0) {
      renderPage(page);
    }
  });

  function handlePrevPage() {
    if (currentPage() > 1) {
      setCurrentPage((p) => p - 1);
    }
  }

  function handleNextPage() {
    if (currentPage() < totalPages()) {
      setCurrentPage((p) => p + 1);
    }
  }

  function handleZoomIn() {
    setZoom((z) => Math.min(z + 25, 300));
  }

  function handleZoomOut() {
    setZoom((z) => Math.max(z - 25, 50));
  }

  function handleZoomReset() {
    setZoom(100);
  }

  function handlePageInput(e: Event) {
    const input = e.target as HTMLInputElement;
    const page = parseInt(input.value, 10);
    if (!Number.isNaN(page) && page >= 1 && page <= totalPages()) {
      setCurrentPage(page);
    }
  }

  const fileName = () => {
    const parts = props.filePath.split("/");
    return parts[parts.length - 1];
  };

  const btnClass =
    "bg-transparent border border-[rgba(148,163,184,0.25)] text-foreground w-8 h-8 rounded flex items-center justify-center text-base cursor-pointer transition-all hover:bg-[rgba(148,163,184,0.15)] hover:border-[rgba(148,163,184,0.4)] disabled:opacity-40 disabled:cursor-not-allowed";

  return (
    <div class="flex flex-col h-full bg-card">
      <div class="flex items-center justify-between px-4 py-2 bg-popover border-b border-[rgba(148,163,184,0.15)] shrink-0 gap-4">
        <div class="flex-1 min-w-0">
          <span class="font-medium text-foreground overflow-hidden text-ellipsis whitespace-nowrap">
            {fileName()}
          </span>
        </div>

        <div class="flex items-center gap-2">
          <button
            type="button"
            class={btnClass}
            onClick={handlePrevPage}
            disabled={currentPage() <= 1}
            title="Previous Page"
          >
            ◀
          </button>
          <span class="flex items-center gap-1 text-muted-foreground text-[13px]">
            <input
              type="number"
              class="w-[50px] px-2 py-1 bg-card border border-[rgba(148,163,184,0.25)] rounded text-foreground text-[13px] text-center focus:outline-none focus:border-accent [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
              value={currentPage()}
              min={1}
              max={totalPages()}
              onChange={handlePageInput}
            />
            <span>/ {totalPages()}</span>
          </span>
          <button
            type="button"
            class={btnClass}
            onClick={handleNextPage}
            disabled={currentPage() >= totalPages()}
            title="Next Page"
          >
            ▶
          </button>
        </div>

        <div class="flex items-center gap-2">
          <button
            type="button"
            class={btnClass}
            onClick={handleZoomOut}
            title="Zoom Out"
          >
            −
          </button>
          <span class="min-w-[50px] text-center text-[13px] text-muted-foreground">
            {zoom()}%
          </span>
          <button
            type="button"
            class={btnClass}
            onClick={handleZoomIn}
            title="Zoom In"
          >
            +
          </button>
          <button
            type="button"
            class={btnClass}
            onClick={handleZoomReset}
            title="Reset Zoom"
          >
            ⟳
          </button>
        </div>
      </div>

      <div class="flex-1 overflow-auto flex justify-center p-5 bg-[#525659]">
        {isLoading() ? (
          <div class="flex items-center justify-center h-full w-full text-muted-foreground text-sm">
            Loading PDF...
          </div>
        ) : error() ? (
          <div class="flex items-center justify-center h-full w-full text-destructive text-sm">
            {error()}
          </div>
        ) : (
          <canvas
            ref={canvasRef}
            class="shadow-[0_4px_20px_rgba(0,0,0,0.3)] bg-white"
          />
        )}
      </div>
    </div>
  );
};

export default PdfViewer;
