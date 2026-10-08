window.__turnstileReady = new Promise((resolve) => {
  window.onFeedlogTurnstileLoad = function () {
    resolve();
  };
});
