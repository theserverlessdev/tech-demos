// Registers the Turnstile onload hook before api.js runs. CSP forbids inline scripts.
window.__turnstileReady = new Promise((resolve) => {
  window.onTempEmailTurnstileLoad = () => resolve();
});
