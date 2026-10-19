/* Safe code and Markdown rendering helpers. All runtime assets are local. */
(function () {
  'use strict';

  const BB = (window.BB = window.BB || {});
  const MERMAID_DISPLAY_MAX_WIDTH = 680;
  const MERMAID_DISPLAY_MAX_HEIGHT = 500;
  let mermaidInitialized = false;
  let mermaidSequence = 0;
  const blockedTags = new Set([
    'SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'FRAME', 'FRAMESET',
    'FORM', 'INPUT', 'BUTTON', 'TEXTAREA', 'SELECT', 'OPTION',
    'LINK', 'META', 'BASE', 'SVG', 'MATH'
  ]);
  const urlAttributes = new Set(['href', 'src', 'xlink:href', 'action', 'formaction', 'poster']);

  function safeURL(value, allowDataImages = false) {
    const compact = String(value || '').trim().replace(/[\u0000-\u001f\u007f\s]+/g, '');
    if (!compact) return true;
    const lower = compact.toLowerCase();
    if (allowDataImages && /^data:image\/(?:png|jpeg|gif|webp);base64,/i.test(compact)) return true;
    return !(lower.startsWith('javascript:') || lower.startsWith('vbscript:') || lower.startsWith('data:'));
  }

  function sanitizeHTML(html, options = {}) {
    const template = document.createElement('template');
    template.innerHTML = String(html || '');
    const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_ELEMENT);
    const elements = [];
    while (walker.nextNode()) elements.push(walker.currentNode);
    for (const element of elements) {
      if (blockedTags.has(element.tagName)) {
        element.remove();
        continue;
      }
      for (const attribute of Array.from(element.attributes)) {
        const name = attribute.name.toLowerCase();
        if (name.startsWith('on') || name === 'style' || name === 'srcdoc') {
          element.removeAttribute(attribute.name);
        } else if (urlAttributes.has(name) && !safeURL(attribute.value, options.allowDataImages === true && element.tagName === 'IMG')) {
          element.removeAttribute(attribute.name);
        }
      }
      if (element.tagName === 'A' && element.getAttribute('target') === '_blank') {
        element.setAttribute('rel', 'noopener noreferrer');
      }
    }
    return template.innerHTML;
  }

  function forwardVerticalWheel(scroller) {
    if (!scroller || scroller.dataset.bbVerticalWheelForwarded === 'true') return;
    scroller.dataset.bbVerticalWheelForwarded = 'true';
    scroller.addEventListener('wheel', event => {
      if (event.ctrlKey || event.shiftKey || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      const page = document.scrollingElement || document.documentElement;
      if (!page) return;

      // WheelEvent deltaMode can represent pixels, lines, or pages. Normalize it
      // before moving the document so a mouse wheel behaves like normal page
      // scrolling while the pointer is over the horizontally scrollable source.
      const multiplier = event.deltaMode === 1
        ? 16
        : event.deltaMode === 2
          ? Math.max(1, page.clientHeight)
          : 1;
      const delta = event.deltaY * multiplier;
      const canMove = delta < 0
        ? page.scrollTop > 0
        : page.scrollTop + page.clientHeight < page.scrollHeight - 1;
      if (!canMove || delta === 0) return;
      page.scrollTop += delta;
      event.preventDefault();
    }, { passive: false });
  }

  function renderCode(code, language) {
    const value = code == null ? '' : String(code);
    const wrapper = document.createElement('div');
    wrapper.className = 'code-viewer';

    const numbers = document.createElement('pre');
    numbers.className = 'code-line-numbers';
    numbers.setAttribute('aria-hidden', 'true');
    const lines = value.split('\n');
    const lineCount = Math.max(1, lines.length);
    const longestLine = lines.reduce((maximum, line) => {
      const visualLength = String(line || '').replace(/\t/g, '  ').length;
      return Math.max(maximum, visualLength);
    }, 1);
    const targetWidth = Math.min(1680, Math.max(820, longestLine * 8.25 + 120));
    wrapper.style.setProperty('--code-content-width', `${Math.round(targetWidth)}px`);
    wrapper.dataset.longestLine = String(longestLine);
    const numberFragment = document.createDocumentFragment();
    for (let line = 1; line <= lineCount; line++) {
      const span = document.createElement('span');
      span.textContent = String(line);
      numberFragment.appendChild(span);
    }
    numbers.appendChild(numberFragment);

    const horizontal = document.createElement('div');
    horizontal.className = 'code-horizontal-scroll';
    const source = document.createElement('pre');
    source.className = 'code-source';
    const codeElement = document.createElement('code');
    codeElement.textContent = value;
    if (language) codeElement.className = `language-${language}`;
    source.appendChild(codeElement);
    try {
      if (window.hljs) window.hljs.highlightElement(codeElement);
    } catch (_) {}

    horizontal.appendChild(source);
    forwardVerticalWheel(horizontal);
    wrapper.append(numbers, horizontal);
    return wrapper;
  }

  function appendSyntaxToken(parent, value, className = '') {
    if (!value) return;
    if (!className) {
      parent.appendChild(document.createTextNode(value));
      return;
    }
    const token = document.createElement('span');
    token.className = className;
    token.textContent = value;
    parent.appendChild(token);
  }

  function highlightJSONLine(line, state) {
    const fragment = document.createDocumentFragment();
    let index = 0;
    const text = String(line || '');

    while (index < text.length) {
      if (state.inString || text[index] === '"') {
        const start = index;
        if (!state.inString) {
          state.inString = true;
          state.escaped = false;
          index++;
        }
        let closed = false;
        while (index < text.length) {
          const current = text[index++];
          if (state.escaped) {
            state.escaped = false;
          } else if (current === '\\') {
            state.escaped = true;
          } else if (current === '"') {
            state.inString = false;
            closed = true;
            break;
          }
        }
        let lookahead = index;
        while (lookahead < text.length && /\s/.test(text[lookahead])) lookahead++;
        const isKey = closed && text[lookahead] === ':';
        appendSyntaxToken(fragment, text.slice(start, index), isKey ? 'json-syntax-key json-token-string' : 'json-syntax-string json-token-string');
        continue;
      }

      const current = text[index];
      if (/\s/.test(current)) {
        const start = index++;
        while (index < text.length && /\s/.test(text[index])) index++;
        appendSyntaxToken(fragment, text.slice(start, index));
        continue;
      }

      if ('{}[],:'.includes(current)) {
        appendSyntaxToken(fragment, current, 'json-syntax-punctuation');
        index++;
        continue;
      }

      const remainder = text.slice(index);
      const literal = /^(?:true|false|null)\b/.exec(remainder);
      if (literal) {
        appendSyntaxToken(fragment, literal[0], literal[0] === 'null' ? 'json-syntax-null json-token-null' : 'json-syntax-boolean json-token-boolean');
        index += literal[0].length;
        continue;
      }

      const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(remainder);
      if (number) {
        appendSyntaxToken(fragment, number[0], 'json-syntax-number json-token-number');
        index += number[0].length;
        continue;
      }

      const start = index++;
      while (index < text.length && !/[\s{}[\],:"]/.test(text[index])) index++;
      appendSyntaxToken(fragment, text.slice(start, index), 'json-syntax-unknown json-token-invalid');
    }
    return fragment;
  }

  function renderWrappedCode(code, language, options = {}) {
    const value = code == null ? '' : String(code);
    const startLine = Math.max(1, Number(options.startLine) || 1);
    const continued = options.continued === true;
    const wrapper = document.createElement('div');
    wrapper.className = 'wrapped-code-viewer';
    if (language) wrapper.dataset.language = String(language);

    const lines = value.split('\n');
    if (!lines.length) lines.push('');
    const fragment = document.createDocumentFragment();
    const jsonState = {
      inString: language === 'json' && (options.startInString === true || options.startsInString === true),
      escaped: language === 'json' && options.startEscaped === true
    };
    lines.forEach((line, index) => {
      const row = document.createElement('div');
      row.className = 'wrapped-code-row';
      const number = document.createElement('span');
      number.className = 'wrapped-code-line-number';
      number.setAttribute('aria-hidden', 'true');
      number.textContent = `${startLine + index}${continued && index === 0 ? '↳' : ''}`;
      const content = document.createElement('code');
      content.className = 'wrapped-code-line';
      if (language === 'json') {
        content.appendChild(highlightJSONLine(line, jsonState));
        if (!content.childNodes.length) content.textContent = '\u200b';
      } else {
        content.textContent = line || '\u200b';
      }
      row.append(number, content);
      fragment.appendChild(row);
    });
    wrapper.appendChild(fragment);
    return wrapper;
  }

  function renderWrappedJSON(code, options = {}) {
    return renderWrappedCode(code, 'json', options);
  }

  function prepareMermaidBlocks(wrapper) {
    const selectors = [
      'pre > code.language-mermaid',
      'pre > code.lang-mermaid'
    ];
    wrapper.querySelectorAll(selectors.join(',')).forEach(codeElement => {
      const pre = codeElement.parentElement;
      if (!pre) return;
      const figure = document.createElement('figure');
      figure.className = 'mermaid-preview';
      figure.dataset.mermaidSource = codeElement.textContent || '';
      const loading = document.createElement('div');
      loading.className = 'mermaid-preview-loading';
      const icon = document.createElement('i');
      icon.className = 'mdi mdi-loading mdi-spin';
      const label = document.createElement('span');
      label.textContent = 'Rendering Mermaid diagram...';
      loading.append(icon, label);
      figure.appendChild(loading);
      pre.replaceWith(figure);
    });
  }

  function loadMermaid() {
    if (window.mermaid) return Promise.resolve(window.mermaid);
    return Promise.reject(new Error('The optional Mermaid renderer is not embedded in this build. The diagram source remains available below.'));
  }

  function renderMermaidFailure(figure, source, error) {
    figure.classList.add('is-error');
    const message = document.createElement('div');
    message.className = 'mermaid-preview-error';
    const icon = document.createElement('i');
    icon.className = 'mdi mdi-alert-circle-outline';
    const text = document.createElement('span');
    text.textContent = `Mermaid preview unavailable: ${String(error?.message || error || 'unknown error')}`;
    message.append(icon, text);

    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = 'Show Mermaid source';
    const pre = document.createElement('pre');
    const code = document.createElement('code');
    code.className = 'language-mermaid';
    code.textContent = source;
    pre.appendChild(code);
    details.append(summary, pre);
    figure.replaceChildren(message, details);
  }

  function sanitizeMermaidSVG(svg) {
    const parser = new DOMParser();
    const documentNode = parser.parseFromString(String(svg || ''), 'image/svg+xml');
    if (documentNode.querySelector('parsererror')) throw new Error('The Mermaid renderer returned invalid SVG.');
    const source = documentNode.documentElement;
    if (!source || source.localName.toLowerCase() !== 'svg') throw new Error('The Mermaid renderer did not return an SVG document.');

    source.querySelectorAll('script, iframe, object, embed, image, link, meta, foreignObject').forEach(element => element.remove());
    for (const element of [source, ...source.querySelectorAll('*')]) {
      for (const attribute of Array.from(element.attributes || [])) {
        const name = attribute.name.toLowerCase();
        const value = String(attribute.value || '').trim();
        if (name.startsWith('on')) {
          element.removeAttribute(attribute.name);
          continue;
        }
        if (name === 'href' || name === 'xlink:href') {
          if (!value.startsWith('#')) element.removeAttribute(attribute.name);
          continue;
        }
        if (name === 'style' && /url\s*\((?!\s*["']?#)/i.test(value)) {
          element.removeAttribute(attribute.name);
        }
      }
    }

    const viewBox = String(source.getAttribute('viewBox') || '').trim().split(/[ ,]+/).map(Number);
    let naturalWidth = viewBox.length === 4 && Number.isFinite(viewBox[2]) && viewBox[2] > 0
      ? viewBox[2]
      : Number.parseFloat(source.getAttribute('width'));
    let naturalHeight = viewBox.length === 4 && Number.isFinite(viewBox[3]) && viewBox[3] > 0
      ? viewBox[3]
      : Number.parseFloat(source.getAttribute('height'));
    if (!Number.isFinite(naturalWidth) || naturalWidth <= 0) naturalWidth = MERMAID_DISPLAY_MAX_WIDTH;
    if (!Number.isFinite(naturalHeight) || naturalHeight <= 0) naturalHeight = Math.min(MERMAID_DISPLAY_MAX_HEIGHT, naturalWidth * 0.75);
    const displayScale = Math.min(
      1,
      MERMAID_DISPLAY_MAX_WIDTH / naturalWidth,
      MERMAID_DISPLAY_MAX_HEIGHT / naturalHeight
    );
    const displayWidth = Math.max(1, Math.round(naturalWidth * displayScale));
    const displayHeight = Math.max(1, Math.round(naturalHeight * displayScale));

    const imported = document.importNode(source, true);
    imported.classList.add('mermaid-preview-svg');
    imported.setAttribute('role', 'img');
    imported.setAttribute('aria-label', 'Mermaid diagram');
    imported.setAttribute('width', String(displayWidth));
    imported.setAttribute('height', String(displayHeight));
    imported.setAttribute('preserveAspectRatio', 'xMidYMin meet');
    imported.dataset.naturalWidth = String(Math.round(naturalWidth));
    imported.dataset.naturalHeight = String(Math.round(naturalHeight));
    imported.removeAttribute('style');
    return imported;
  }

  async function renderMermaid(root) {
    const figures = Array.from(root?.querySelectorAll?.('.mermaid-preview[data-mermaid-source]') || []);
    if (!figures.length) return;

    let mermaid;
    try {
      mermaid = await loadMermaid();
      if (!mermaidInitialized) {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: 'default',
          maxTextSize: 100000,
          maxEdges: 10000,
          htmlLabels: false,
          flowchart: { htmlLabels: false, useMaxWidth: true }
        });
        mermaidInitialized = true;
      }
    } catch (error) {
      figures.forEach(figure => renderMermaidFailure(figure, figure.dataset.mermaidSource || '', error));
      return;
    }

    for (const figure of figures) {
      const source = figure.dataset.mermaidSource || '';
      try {
        const id = `bb-mermaid-${Date.now().toString(36)}-${++mermaidSequence}`;
        const result = await mermaid.render(id, source);
        const svg = String(result?.svg || '');
        if (!svg) throw new Error('The Mermaid renderer returned an empty diagram.');
        const diagram = sanitizeMermaidSVG(svg);
        figure.classList.add('is-rendered');
        figure.replaceChildren(diagram);
      } catch (error) {
        renderMermaidFailure(figure, source, error);
      }
    }
  }

  function renderMarkdown(markdown) {
    const parsed = window.marked ? window.marked.parse(markdown || '') : String(markdown || '');
    const wrapper = document.createElement('div');
    wrapper.className = 'markdown-body';
    wrapper.innerHTML = sanitizeHTML(parsed);
    prepareMermaidBlocks(wrapper);
    try {
      if (window.hljs) wrapper.querySelectorAll('pre code:not(.language-mermaid):not(.lang-mermaid)').forEach(element => window.hljs.highlightElement(element));
    } catch (_) {}
    return wrapper;
  }

  BB.render = { renderCode, renderWrappedCode, renderWrappedJSON, renderMarkdown, renderMermaid, sanitizeMermaidSVG, sanitizeHTML, forwardVerticalWheel };
})();
