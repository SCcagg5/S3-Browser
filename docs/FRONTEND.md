# Frontend design system

The interface is plain HTML, CSS and JavaScript embedded in the Go binary. Vue 3 drives the object browser page; the preview page uses small vanilla modules. There is no bundler, no CSS framework and no runtime request outside the application origin. The one generated file is the compiled Vue template (below).

## The object browser template

The browser page's markup is `src/frontend/app.template.html`. It is compiled ahead of time into `src/public/assets/js/app.render.js`, so the page ships Vue's runtime-only build: no template compiler is downloaded or run, and the Content-Security-Policy is `script-src 'self'` with no `'unsafe-eval'`.

After editing the template, run this in `tools/` and commit both files (CI runs `npm run check` and fails when the generated file is stale):

```sh
npm ci && npm run build
```

## Stylesheets

Each page links only the layers it needs, in this order. The last layer wins.

| File | Used by | Purpose |
|---|---|---|
| `icons.css` | both | Local MDI icon masks (`mdi mdi-<name>`). |
| `tokens.css` | both | Every colour, size, radius, shadow, layer and duration. Light and dark themes. |
| `base.css` | both | Reset, element defaults, the `[hidden]` utility. |
| `ui.css` | both | Shared controls (`.btn`, `.input`, `.select`, `.card`, `.table`), menus, dialogs, toasts, transfer queue, data grids. |
| `treemap.css` | browser | Folder insights treemap. |
| `browser.css` | browser | Header, storage switcher, toolbar, listing, empty and error states. |
| `markdown.css`, `syntax.css` | preview | Rendered Markdown and the highlight.js token theme, both driven by tokens. |
| `preview.css` | preview | Preview shell and every viewer. |
| `a11y.css` | both | Keyboard focus ring, touch-target floor, reduced motion. Always last. |

## Tokens and themes

All values live in `tokens.css`. Other stylesheets use `var(--token)` only: no hex or `rgb()` literals, no `zoom`, no z-index above the token scale, and no literal `padding`, `margin` or `gap` beyond hairlines (fluid `clamp()` values aside).

- **Surfaces and text** are semantic (`--color-bg-panel`, `--color-text-muted`), never named after a hue.
- **Accent** has two roles: `--color-primary` for links, icons and rings, and `--color-primary-solid` for the fill behind white text. They differ in dark mode so that both keep 4.5:1.
- **Dark theme** follows `prefers-color-scheme`. A colour that is not re-declared for dark must be listed as an invariant in `test/design-system.js` (inverse surfaces, white-on-solid text).
- **Type** uses a 12/13/14/16/18/20/24px scale (`--font-size-*`). Nothing renders below 12px.
- **Spacing** is a 4px grid with half steps (`--space-0` … `--space-12`; `1h`, `2h`, `3h` are 6, 10 and 14px).
- **Form fields** draw their edge with `--color-control-border`, 3:1 against every surface in both themes (WCAG 1.4.11); decorative separators use `--color-border`.
- **Density** is true-size. The old `body { zoom: .8 }` is gone; control height is `--control-height-*`.
- **Text scaling**: the root font size follows the user setting (`html { font-size: 100% }`) and control sizes (`--control-height-*`, `--target-size`, row heights) are `rem`. Controls declare `min-height`/`min-width`, never a fixed `height`/`width`, so 200% text grows them instead of clipping.
- **Icons** are local SVG masks (`icons.css` plus `assets/icons/mdi/`). `test/design-system.js` fails when a script or page uses an `mdi-*` name that has no rule or no SVG.

## Accessibility contract

- Keyboard: interactive things are real `<button>`, `<a href>` or form controls, so file and folder names open in a new tab like any link. Row and toolbar menus follow the ARIA menu pattern (`menu.js`): Enter or Arrow opens and focuses the first item, Arrow/Home/End move, Escape closes, Tab closes and continues from the trigger. Activating an item returns focus to the trigger unless the action moved it (a dialog, a file chooser). The breadcrumb "hidden folders" menu behaves the same way.
- Re-rendering never drops focus to `<body>`: a control that is disabled while its action runs (Refresh, "Count lines", pager buttons, "Run check") gets focus back when it is enabled again (`ui.js`, a `disabled`-attribute observer); the grid viewers swap their content through `BB.ui.replaceContent`, which refocuses the equivalent control (a focused tab follows the selection); the pager hands focus to the other pager button or the main content when the one just used becomes unavailable.
- Tabs use `BB.ui.enhanceTabs`: roving tabindex, Arrow/Home/End, `aria-controls` and `role="tabpanel"`. Tab strips with no select fallback stay visible on phones and scroll sideways.
- The JSON tree is one tab stop: Up/Down/Home/End move between nodes, Right expands, Left collapses or goes to the parent; each node is named "Expand <key>" / "Collapse <key>" with `aria-expanded`.
- Dialogs (`ui.js`) are `alertdialog`/`dialog` with a name (a level-2 heading), trap Tab (by tab order, so roving-tabindex tabs work), open on a focused control (the selected tab when there are tabs), focus a safe control, and on close return focus to the control that opened them (the main content when that control is gone).
- Focus: `a11y.css` draws one solid 2px ring (`--color-primary`, `!important`) on every focusable control, so no component rule can weaken it. The offset defaults to 2px; inside clipping containers (scrollers, tab strips, table cells, list rows) it is -2px so the ring is drawn inside the control. Elements focused by script (`tabindex="-1"`, such as `<main>`) draw no ring.
- Notifications (`ui.js`): toasts carry a status (`success`, `info`, `warning`, `error`), have a close button, pause while hovered or focused, stay at least 4 seconds, and errors use `role="alert"`; progress bars are named. There is no extra live region around them.
- Touch: under `pointer: coarse`, controls reach 44px. The floor in `a11y.css` has zero specificity (`:where`), so components keep larger sizes; `--control-height-*` already switch to 44px. Data grids let vertical swipes reach the page (`overscroll-behavior-y: auto`), and the 7px column resize handle is hidden on touch screens (arrow keys and double click remain for fine pointers).
- Motion: under `prefers-reduced-motion` the `--duration-*` tokens become `0s` (state changes are instant), shimmer and indeterminate bars freeze into a static bar, and spinners slow down instead of disappearing. Progress fills animate with `transform`, not `width`.
- Forced colours: icons keep their fill, progress bars use `Highlight`, dialogs and popovers get a border.
- The skip link handles its own click because the page uses `<base href>`.

## Untrusted content

Markdown may contain raw HTML. `BB.render.sanitizeHTML` keeps only plain HTML elements (it judges `localName` and namespace, so SVG and MathML are removed whatever their case), drops `id`, `name`, `class` (except a code block's `language-*`), `style`, `srcdoc`, `srcset` and every `on*` handler, blocks `javascript:`, `vbscript:` and `data:` URLs, and rebuilds task-list checkboxes from scratch. Class and id are dropped so content can neither impersonate application dialogs nor clobber globals. `test/e2e` renders a hostile document and fails if any of it survives. The Content-Security-Policy is the second line of defence, not the first.

## Loading

- Every script is `defer`. The preview page loads each viewer module (JSON, tabular, SQLite, structured, highlight.js, marked) on demand, only for the file type being opened.
- The Go server gzips embedded text assets and HTML when the client accepts it (`src/static_compress.go`). Range and HEAD requests are served untouched.
- First-party files keep stable names, so the server fingerprints them: the HTML pages carry a hash of the whole embedded frontend on every asset URL (`?v=<hash>`, also on the icon URLs inside stylesheets and on lazily loaded viewer modules). A request with the current hash is `immutable` for a year; one without it (or with an old hash) is `no-cache` with a weak content `ETag`, so a 304 is the worst case. A new binary changes the hash, so no page can mix new markup with stale scripts. Vendored libraries live under versioned paths and are `immutable` too.
- Gzip bodies are compressed once per content and kept in memory.
- Unknown addresses get a styled 404 page when the browser asks for HTML.

## Tests

`test/design-system.js` enforces the contract: AA contrast of every token pair in both themes (and 3:1 for form-field edges), no literal colours, the `!important` budget, no framework, the 12px floor, the z-index scale, spacing tokens, rem-based control sizes, icon existence, and that every stylesheet is linked. The other `test/*.js` files pin behavior of individual viewers.

`test/e2e/` complements them with browser behaviour tests (focus, keyboard, touch, text size, forced colours, axe); see `test/README.md`.

Run the source-level tests:

```sh
for file in test/*.js; do node "$file"; done
```
