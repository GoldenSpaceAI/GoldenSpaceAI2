/* Persist theme with the chat app: localStorage goldenspaceai2_theme + html.light */
(function () {
  var KEY = 'goldenspaceai2_theme';

  function readStored() {
    try { return localStorage.getItem(KEY); } catch (e) { return null; }
  }

  function preferred() {
    var stored = readStored();
    if (stored === 'light' || stored === 'dark') return stored;
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) return 'light';
    return 'dark';
  }

  function apply(theme) {
    var light = theme === 'light';
    document.documentElement.classList.toggle('light', light);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', light ? '#f5f3eb' : '#0a0a0a');
    try { localStorage.setItem(KEY, light ? 'light' : 'dark'); } catch (e) {}
    var label = light ? 'Dark' : 'Light';
    document.querySelectorAll('[data-theme-toggle]').forEach(function (btn) {
      btn.textContent = label;
      btn.setAttribute('aria-pressed', light ? 'true' : 'false');
      btn.setAttribute('aria-label', light ? 'Switch to dark theme' : 'Switch to light theme');
    });
  }

  function toggle() {
    apply(document.documentElement.classList.contains('light') ? 'dark' : 'light');
  }

  document.addEventListener('DOMContentLoaded', function () {
    apply(document.documentElement.classList.contains('light') ? 'light' : preferred());
    document.querySelectorAll('[data-theme-toggle]').forEach(function (btn) {
      btn.addEventListener('click', toggle);
    });
  });

  window.addEventListener('storage', function (e) {
    if (e.key === KEY && (e.newValue === 'light' || e.newValue === 'dark')) apply(e.newValue);
  });
})();
