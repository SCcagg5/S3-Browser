# PDF.js 4.10.38

The application uses a local PDF.js canvas renderer. Runtime requests never
load PDF.js from a CDN.

Place these official `pdfjs-dist` 4.10.38 browser-compatible ESM assets in this directory
before testing or compiling the application:

```text
pdf.min.mjs
pdf.worker.min.mjs
LICENSE
```

The Go binary embeds the complete `src/public` directory. No installer script
or Makefile is included in the distributed project.
