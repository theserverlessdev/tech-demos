(function () {
  try {
    var stored = localStorage.getItem("theme");
    document.documentElement.setAttribute("data-theme", stored || "dark");
  } catch (e) {}
})();
