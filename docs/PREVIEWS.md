# Preview and metadata behavior

## Deterministic-by-default rule

The application displays metadata automatically only when it can obtain the complete value deterministically from a small, bounded part of the object, such as:

- a fixed header;
- a footer or trailer;
- an internal index;
- a ZIP central directory;
- a small Office property entry;
- a provider object header.

It does not present partial scans as complete information. A value that requires a full scan is hidden until the user explicitly starts the corresponding operation. The result is shown only when that operation completes.

## PDF

PDF preview uses local PDF.js, a worker, a controlled canvas, and `PDFDataRangeTransport` over exact same-origin ranges. Streaming and automatic full-document fetching are disabled. The current page is rendered and only bounded adjacent state is retained.

The object gateway requires finite PDF ranges and rejects unbounded, suffix-only, multi-range, or oversized range requests.

## Office Open XML

DOCX, DOCM, DOTX, DOTM, XLSX, XLSM, XLTX, XLTM, XLAM, PPTX, PPTM, POTX, POTM, PPSX, PPSM, PPAM, SLDX, SLDM, VSDX, VSDM, VSSX, VSSM, VSTX, and VSTM use the ZIP central directory plus targeted property files.

Workbook row and column counts are not claimed from an unreliable formatted dimension. Exact active-sheet dimensions remain behind an explicit scan.

## Structured personal-information formats

VCF/vCard, ICS/IFB, EML/MIME/MHTML, certificates, requests, and public or private key files have structured previews plus a raw-data view. Email HTML is not executed. External images, styles, scripts, tracking pixels, and URLs are never fetched.

## Images and media

Supported browser image, audio, and video types use same-origin object URLs. Audio and video use `preload="metadata"`. SVG is served under restrictive content security headers and cannot load external resources.

## Archives

ZIP and ZIP-derived formats use the complete central directory, without extracting contained files:

- ZIP, JAR, WAR, EAR;
- APK, AAR, XPI, CRX, VSIX;
- EPUB.

The archive preview omits the separate Details summary. EPUB may show a Publication section, followed by Contents; other supported ZIP-derived formats show Contents directly. The preview uses the same maximum width as the main object navigation. The entry grid offers 100, 250, 500, and 1,000 rows per page and uses one shared column-width contract for headers and data.

Formats without a deterministic central inventory, such as TAR, RAR, and 7z, are not partially listed by default.

## Tabular formats

CSV, TSV, PSV, XLSX, XLSM, SQLite, JSONL/NDJSON, and Parquet-compatible views use shared grid primitives. Column filtering, sorting, pagination, loading, empty, and error states are normalized.

## Open original

The original-object endpoint returns the real file name through `Content-Disposition`. Browser-displayable content is served inline; other content is served as an attachment with the correct object name. Folder archives use the folder name rather than a generic gateway name.
