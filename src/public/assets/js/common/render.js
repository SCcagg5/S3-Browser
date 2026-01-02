/*!
 * BB.render — helpers for render (code + markdown) with highlight.js
 * Dependencies: window.hljs (+ marked for markdown)
 */
(function () {
  const BB = (window.BB = window.BB || {});

  function renderCode(code, lang, in_pre=true) {
    
    const codeEl = document.createElement('code');
    codeEl.textContent = code == null ? '' : String(code);
    if (lang) codeEl.className = 'language-' + lang;
    try { if (window.hljs) hljs.highlightElement(codeEl); } catch {}
    if (in_pre === true) {
        const pre = document.createElement('pre');
        pre.appendChild(codeEl);
        return pre;
    }
    codeEl.innerHTML = codeEl.innerHTML.replaceAll("\n", "<br>").replaceAll("<span  ", "<span ").replaceAll(" ", "&nbsp").replaceAll("<span&nbsp", "<span ");
    return codeEl;
  }

  function renderMarkdown(md) {
    const html = (window.marked ? marked.parse(md || '') : String(md || ''));
    const wrap = document.createElement('div');
    wrap.className = 'markdown-body';
    wrap.innerHTML = html;
    try {
      if (window.hljs) wrap.querySelectorAll('pre code').forEach((el) => hljs.highlightElement(el));
    } catch {}
    return wrap;
  }

  BB.render = { renderCode, renderMarkdown };
})();
