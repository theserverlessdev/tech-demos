window.__turnstileReady = new Promise(function (resolve) {
  window.onR2DriveTurnstileLoad = function () {
    resolve();
  };
});
