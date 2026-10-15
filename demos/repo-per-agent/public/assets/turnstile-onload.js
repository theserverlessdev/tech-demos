window.__turnstileReady = new Promise((resolve) => {
  window.onRepoPerAgentTurnstileLoad = function () {
    resolve();
  };
});
