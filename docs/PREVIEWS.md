# Preview and metadata behavior

## General rules

A preview may read only deterministic, bounded format structures by default. Exact values that require a complete scan are absent until the user starts an explicit operation. Partial inventories are never presented as complete.

Preview code does not fetch URLs referenced inside documents. HTML-like content is sanitized, SVG active content is blocked, and external EPUB/email resources are displayed only as text.

Selecting an immutable object version updates Preview, Details, Open original, Inspect, and Verify integrity to use that exact provider version or generation.

## PDF

PDF uses the local PDF.js ESM module and worker, a canvas controlled by the application, a custom `PDFDataRangeTransport`, and strict same-origin Range requests.

- no iframe, embed, object element, or native-browser fallback;
- streaming and automatic whole-file fetching are disabled;
- the page count comes from the parsed PDF structure;
- only the current page and a bounded next-page cache are retained;
- page and zoom controls operate on the PDF.js document;
- the viewer is constrained to the viewport after accounting for the application header and PDF controls.

Required release assets:

```text
src/public/assets/vendor/pdfjs/4.10.38/pdf.min.mjs
src/public/assets/vendor/pdfjs/4.10.38/pdf.worker.min.mjs
```

## Office Open XML

Word, Excel, PowerPoint, and Visio package metadata comes from the ZIP central directory and small known package members such as `docProps/core.xml`, `docProps/app.xml`, and `docProps/custom.xml`.

Word preview renders semantic paragraphs, headings, lists, links, and tables. Excel-family preview uses the shared DataGrid and loads workbook structures and selected worksheet data through range-backed ZIP access. PowerPoint and Visio currently expose deterministic metadata rather than a pixel-identical renderer.

Worksheet row/column totals that require a full active-sheet scan appear only after the explicit scan action completes.

## Tabular data

Delimited text, Excel-family worksheets, SQLite, JSONL/NDJSON, and Parquet views use shared grid behavior:

- consistent filters, sorting, pagination, loading, empty, and error states;
- right-aligned tabular numbers;
- bounded page sizes;
- full available width;
- no full dataset materialization solely for initial display.

SQLite reads remote database pages through exact ranges. A row total is not treated as zero when it is unknown.

## JSON

Raw, beautified, summary, and tree views are distinct modes. Exact line/page totals are shown only after an explicit complete count. The count action is not shown in tree mode, and no status label is displayed after completion beyond the exact totals.

## Structured text

The structured viewer covers vCard/VCF, iCalendar/IFB, EML/MIME/MHTML, certificates, certificate requests, public/private key files, and related deterministic metadata.

Certificate and key previews provide structured fields plus a Raw tab. Binary content is represented as Base64. Raw private-key content is visible only because this is an explicit product requirement; it is never sent to a third party.

Email HTML is not injected as active content. Attachments are listed without automatically decoding or fetching external resources.

## Images, audio, and video

Supported browser image formats use the existing local image viewer. SVG is served with restrictive security headers. Audio and video use the same-origin object gateway and `preload="metadata"`; codec support depends on the browser.

## ZIP-compatible packages

ZIP, JAR, WAR, EAR, APK, AAR, XPI, CRX, VSIX, and EPUB use the exact central directory. The preview displays only deterministic package/publication information and the complete Contents table.

Contents use page-level vertical scrolling and horizontal scrolling only when required. Entries can be opened, downloaded, verified, or selected for extraction. No URL contained in an archive or EPUB is followed.

Formats without a deterministic central inventory, such as TAR, RAR, and 7z, are not partially inventoried by default.

## Per-object integrity

Verify integrity is an explicit complete-object stream. It reports SHA-256 and provider-comparison hashes without retaining object bytes. Composite provider values are displayed but are not falsely compared with a whole-object digest. The action is available only in the Advanced tab of Details and starts only after an explicit click. Its result is rendered in that tab.

There is no global checksum export and no global duplicate scan.

## Technical inspection

Inspect is available only in the Advanced tab of Details and starts only after an explicit click. Its result is rendered in that tab. It reads deterministic object metadata, the first 64 KiB, and when useful the final 64 KiB. It reports:

- declared and detected MIME/type;
- safe provider headers and checksums;
- recognized structural markers;
- bounded hexadecimal and ASCII probes;
- exact provider requests and bytes consumed.

Credential-bearing headers are removed before the response reaches the frontend.
