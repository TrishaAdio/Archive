(function () {
  var root = document.documentElement;
  var reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  try {
    if (root.hasAttribute("data-splash-page") && localStorage.getItem("gp_splash_v1") !== "1") {
      root.setAttribute("data-splash", "on");
    }
    if (sessionStorage.getItem("gp_arrival") === "1") {
      sessionStorage.removeItem("gp_arrival");
      if (!reduceMotion) root.setAttribute("data-arrival", "on");
    }
  } catch (error) {
    root.removeAttribute("data-splash");
  }

  if (!root.hasAttribute("data-splash")) root.classList.add("is-ready");
})();
