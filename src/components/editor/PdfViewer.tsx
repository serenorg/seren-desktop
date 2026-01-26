// ABOUTME: PDF viewer component for displaying PDF files.
// ABOUTME: Uses pdf.js for rendering with page navigation and zoom controls.

import { Component, createSignal, createEffect, onCleanup, onMount } from "solid-js";
import * as pdfjsLib from "pdfjs-dist";
import "./PdfViewer.css";

// Set up the worker
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url
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
    const z = zoom();
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
    if (!isNaN(page) && page >= 1 && page <= totalPages()) {
      setCurrentPage(page);
    }
  }

  const fileName = () => {
    const parts = props.filePath.split("/");
    return parts[parts.length - 1];
  };

  return (
    <div class="pdf-viewer">
      <div class="pdf-viewer-toolbar">
        <div class="pdf-viewer-info">
          <span class="pdf-viewer-filename">{fileName()}</span>
        </div>

        <div class="pdf-viewer-navigation">
          <button
            type="button"
            class="pdf-viewer-btn"
            onClick={handlePrevPage}
            disabled={currentPage() <= 1}
            title="Previous Page"
          >
            ◀
          </button>
          <span class="pdf-viewer-page-info">
            <input
              type="number"
              class="pdf-viewer-page-input"
              value={currentPage()}
              min={1}
              max={totalPages()}
              onChange={handlePageInput}
            />
            <span>/ {totalPages()}</span>
          </span>
          <button
            type="button"
            class="pdf-viewer-btn"
            onClick={handleNextPage}
            disabled={currentPage() >= totalPages()}
            title="Next Page"
          >
            ▶
          </button>
        </div>

        <div class="pdf-viewer-controls">
          <button
            type="button"
            class="pdf-viewer-btn"
            onClick={handleZoomOut}
            title="Zoom Out"
          >
            −
          </button>
          <span class="pdf-viewer-zoom">{zoom()}%</span>
          <button
            type="button"
            class="pdf-viewer-btn"
            onClick={handleZoomIn}
            title="Zoom In"
          >
            +
          </button>
          <button
            type="button"
            class="pdf-viewer-btn"
            onClick={handleZoomReset}
            title="Reset Zoom"
          >
            ⟳
          </button>
        </div>
      </div>

      <div class="pdf-viewer-container">
        {isLoading() ? (
          <div class="pdf-viewer-loading">Loading PDF...</div>
        ) : error() ? (
          <div class="pdf-viewer-error">{error()}</div>
        ) : (
          <canvas ref={canvasRef} class="pdf-viewer-canvas" />
        )}
      </div>
    </div>
  );
};

export default PdfViewer;
