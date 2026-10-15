window.__turnstileReady = new Promise((resolve) => {
  window.onEdgechatTurnstileLoad = function () {
    resolve();
  };
});
