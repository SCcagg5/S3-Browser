/* Theme control: System (default), Dark or Light, saved in this browser only.
   The page loads this script without defer in <head>, so the theme applies before the first paint. The key is the
   key of the portal ("portal.theme"): behind the portal, on the same origin, the two interfaces share one choice.
   The control is a group of three buttons with data-theme-value; without script, the control stays hidden. */
(function () {
  'use strict';
  var KEY = 'portal.theme';
  var root = document.documentElement;
  var mode = 'system';
  try {
    var stored = window.localStorage.getItem(KEY);
    if (stored === 'dark' || stored === 'light') mode = stored;
  } catch (e) {}

  function apply(next) {
    if (next === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', next);
    root.setAttribute('data-theme-mode', next);
  }

  root.classList.add('js');
  apply(mode);

  function mark(group) {
    var buttons = group.querySelectorAll('button[data-theme-value]');
    for (var i = 0; i < buttons.length; i += 1) {
      buttons[i].setAttribute('aria-pressed', String(buttons[i].getAttribute('data-theme-value') === mode));
    }
  }

  function choose(next) {
    mode = next === 'dark' || next === 'light' ? next : 'system';
    try {
      if (mode === 'system') window.localStorage.removeItem(KEY);
      else window.localStorage.setItem(KEY, mode);
    } catch (e) {}
    apply(mode);
    var groups = document.querySelectorAll('[data-theme-switch]');
    for (var i = 0; i < groups.length; i += 1) mark(groups[i]);
  }

  // Another tab (the portal or this page) changed the choice: follow it.
  window.addEventListener('storage', function (event) {
    if (event.key !== KEY) return;
    var next = event.newValue === 'dark' || event.newValue === 'light' ? event.newValue : 'system';
    if (next !== mode) choose(next);
  });

  document.addEventListener('DOMContentLoaded', function () {
    var groups = document.querySelectorAll('[data-theme-switch]');
    for (var i = 0; i < groups.length; i += 1) {
      groups[i].addEventListener('click', function (event) {
        var button = event.target.closest('button[data-theme-value]');
        if (button) choose(button.getAttribute('data-theme-value'));
      });
      mark(groups[i]);
    }
  });

  window.BB = window.BB || {};
  window.BB.theme = { get mode() { return mode; }, choose: choose };
})();
