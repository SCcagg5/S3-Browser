// The buttons "Copy" of the page. The page works without this file.
document.querySelectorAll('[data-copy]').forEach(button => {
  button.addEventListener('click', async () => {
    const source = document.getElementById(button.dataset.copy);
    if (!source || !navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(source.textContent);
      const label = button.textContent;
      button.textContent = 'Copied';
      setTimeout(() => { button.textContent = label; }, 1400);
    } catch (_) { /* the text stays selectable */ }
  });
});
