// Apply the stored theme before paint. The page CSP blocks inline scripts.
(function () {
  try {
    var stored = localStorage.getItem("tanbase-theme");
    var theme = stored || (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
    document.documentElement.setAttribute("data-theme", theme);
  } catch (e) {}
})();
