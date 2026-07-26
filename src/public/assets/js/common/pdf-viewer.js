/* Native PDF embedding is intentionally disabled.
 * PDF preview is handled by preview.js through the local PDF.js canvas renderer
 * and a strict PDFDataRangeTransport. Keeping this namespace avoids breaking
 * stale cached HTML that may still load this file, but no iframe/embed/object is
 * ever created here.
 */
(function () {
  'use strict';
  const BB = (window.BB = window.BB || {});
  BB.pdfViewer = {
    render() {
      throw new Error('Native PDF rendering is disabled. Use the local PDF.js canvas renderer.');
    }
  };
})();
