// Dark-first 3D lobby. Keep the stored theme if present so the hub toggle still applies on return.
(function () {
  try {
    var stored = localStorage.getItem("theme");
    document.documentElement.setAttribute("data-theme", stored || "dark");
  } catch (e) {}
})();
