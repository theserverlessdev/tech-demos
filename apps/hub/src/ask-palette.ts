export const ASK_ORIGIN = "https://ask-the-hub.tech-demos.theserverless.dev";
export const ASK_SITE_KEY = "0x4AAAAAAFRUoj5qDpf7XyIW";

export const ASK_HEADER_BUTTON = `<button class="ask-open" id="ask-open" type="button" hidden title="Search the demos">Search</button>`;

export const ASK_PALETTE_MARKUP = `<button class="ask-bubble" id="ask-bubble" type="button" hidden aria-label="Ask the hub">Ask</button>
  <div class="ask-dialog" id="ask-dialog" hidden>
    <div class="ask-panel" role="dialog" aria-modal="true" aria-labelledby="ask-title">
      <div class="ask-panel__head">
        <h2 id="ask-title">Ask the hub</h2>
        <button class="ask-close" id="ask-close" type="button">Close</button>
      </div>
      <p class="ask-note">Managed RAG over the demo notes in R2. Questions are not stored.</p>
      <div class="ask-chips" id="ask-chips"></div>
      <label class="ask-label" for="ask-q">Question
        <textarea id="ask-q" maxlength="500" rows="3" placeholder="Which demos use Turnstile?"></textarea>
      </label>
      <div class="ask-row">
        <div id="ask-turnstile"></div>
        <button class="ask-go" id="ask-go" type="button">Ask</button>
      </div>
      <p class="ask-status" id="ask-status" role="status"></p>
      <div class="ask-columns">
        <div id="ask-answer" class="ask-answer"></div>
        <div id="ask-chunks" class="ask-chunks"></div>
      </div>
    </div>
  </div>`;

export const ASK_PALETTE_CSS = `
    .ask-open, .ask-close, .ask-go, .ask-bubble, .ask-chip {
      min-width: 44px;
      min-height: 44px;
      border-radius: var(--radius-md);
      border: 1px solid var(--color-border);
      background: transparent;
      color: var(--color-text-light);
      font-family: var(--font-body);
      font-weight: 600;
      font-size: var(--text-sm);
      cursor: pointer;
    }
    .ask-open { padding: 0 0.8rem; }
    .ask-open[hidden], .ask-bubble[hidden], .ask-dialog[hidden] { display: none !important; }
    .ask-bubble {
      position: fixed;
      right: 16px;
      bottom: 16px;
      z-index: 220;
      width: 56px;
      height: 56px;
      border-radius: 999px;
      background: var(--color-primary-start);
      color: #fff;
      border: none;
    }
    .ask-dialog {
      position: fixed;
      inset: 0;
      z-index: 240;
      background: rgba(0, 0, 0, 0.5);
      display: grid;
      align-items: end;
      padding: 12px;
    }
    .ask-panel {
      width: min(720px, 100%);
      max-height: min(100%, 760px);
      overflow: auto;
      margin: 0 auto;
      background: var(--color-background);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-lg);
      padding: 1rem;
    }
    .ask-panel__head { display: flex; justify-content: space-between; align-items: center; gap: 0.75rem; }
    .ask-panel__head h2 { font-size: var(--text-xl); }
    .ask-note, .ask-status { color: var(--color-text-muted); font-size: var(--text-sm); }
    .ask-chips { display: flex; flex-wrap: wrap; gap: 0.5rem; margin: 0.5rem 0; }
    .ask-chip { text-align: left; padding: 0.5rem 0.75rem; }
    .ask-label { display: grid; gap: 0.35rem; font-weight: 600; color: var(--color-text-light); }
    .ask-label textarea {
      width: 100%;
      min-height: 5.5rem;
      border-radius: var(--radius-md);
      border: 1px solid var(--color-border);
      background: transparent;
      color: var(--color-text);
      font: inherit;
      padding: 0.7rem;
    }
    .ask-row { display: flex; flex-wrap: wrap; align-items: center; gap: 0.75rem; margin-top: 0.75rem; }
    .ask-go { background: var(--color-primary-start); color: #fff; border: none; padding: 0 1rem; }
    .ask-columns { display: grid; gap: 0.75rem; margin-top: 0.75rem; }
    .ask-answer, .ask-chunks { overflow-wrap: anywhere; white-space: pre-wrap; }
    .ask-hit { border-top: 1px solid var(--color-border); padding-top: 0.5rem; margin-top: 0.5rem; }
    .ask-hit strong { font-family: var(--font-mono); font-size: var(--text-xs); }
    @media (min-width: 800px) {
      .ask-dialog { align-items: center; }
      .ask-columns { grid-template-columns: 1.1fr 0.9fr; }
    }
    @media (max-width: 600px) {
      .ask-dialog { padding: 0; }
      .ask-panel { width: 100%; max-height: 100%; min-height: 100%; border-radius: 0; }
    }
`;

export const ASK_PALETTE_SCRIPT = `(function () {
      var ORIGIN = ${JSON.stringify(ASK_ORIGIN)};
      var SITE_KEY = ${JSON.stringify(ASK_SITE_KEY)};
      var openBtn = document.getElementById("ask-open");
      var bubble = document.getElementById("ask-bubble");
      var dialog = document.getElementById("ask-dialog");
      var closeBtn = document.getElementById("ask-close");
      var input = document.getElementById("ask-q");
      var go = document.getElementById("ask-go");
      var status = document.getElementById("ask-status");
      var answer = document.getElementById("ask-answer");
      var chunkBox = document.getElementById("ask-chunks");
      var chips = document.getElementById("ask-chips");
      if (!openBtn || !bubble || !dialog || !input || !go) return;
      var samples = [
        "What does the R2 Drive demo prove?",
        "Which demos use Turnstile?",
        "How does Clairic Intake handle a null field?"
      ];
      var token = "";
      var widgetId = "";
      var mountTimer = 0;
      samples.forEach(function (sample) {
        var button = document.createElement("button");
        button.type = "button";
        button.className = "ask-chip";
        button.textContent = sample;
        button.addEventListener("click", function () { input.value = sample; input.focus(); });
        chips.appendChild(button);
      });
      function show() {
        openBtn.hidden = false;
        bubble.hidden = false;
      }
      var ctrl = new AbortController();
      var timer = setTimeout(function () { ctrl.abort(); }, 2500);
      fetch(ORIGIN + "/api/health", { signal: ctrl.signal, mode: "cors" }).then(function (res) {
        clearTimeout(timer);
        if (res.ok) show();
      }).catch(function () { clearTimeout(timer); });
      function openDialog() {
        dialog.hidden = false;
        input.focus();
        ensureTurnstile();
        if (mount()) return;
        if (mountTimer) return;
        var tries = 0;
        mountTimer = setInterval(function () {
          tries += 1;
          if (mount() || tries >= 15) {
            clearInterval(mountTimer);
            mountTimer = 0;
          }
        }, 400);
      }
      function closeDialog() { dialog.hidden = true; }
      openBtn.addEventListener("click", openDialog);
      bubble.addEventListener("click", openDialog);
      closeBtn.addEventListener("click", closeDialog);
      dialog.addEventListener("click", function (event) { if (event.target === dialog) closeDialog(); });
      document.addEventListener("keydown", function (event) {
        var meta = event.metaKey || event.ctrlKey;
        if (meta && (event.key === "k" || event.key === "K")) {
          if (openBtn.hidden) return;
          event.preventDefault();
          if (dialog.hidden) openDialog();
          else closeDialog();
        }
        if (event.key === "Escape" && !dialog.hidden) closeDialog();
      });
      function ensureTurnstile() {
        if (window.turnstile || document.getElementById("ask-turnstile-api")) return;
        var script = document.createElement("script");
        script.id = "ask-turnstile-api";
        script.async = true;
        script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
        document.head.appendChild(script);
      }
      function mount() {
        var host = document.getElementById("ask-turnstile");
        if (!host || host.getAttribute("data-ready") === "1") return true;
        var api = window.turnstile;
        if (!api || typeof api.render !== "function") return false;
        host.setAttribute("data-ready", "1");
        widgetId = api.render(host, {
          sitekey: SITE_KEY,
          action: "ask-the-hub",
          callback: function (value) { token = value; },
          "expired-callback": function () { token = ""; },
          "error-callback": function () { token = ""; }
        });
        return true;
      }
      function paintChunks(list) {
        chunkBox.replaceChildren();
        (list || []).forEach(function (item) {
          var block = document.createElement("article");
          block.className = "ask-hit";
          var title = document.createElement("strong");
          title.textContent = (item.source || "document") + "  " + Number(item.score || 0).toFixed(2);
          var snip = document.createElement("p");
          snip.textContent = item.snippet || "";
          block.append(title, snip);
          chunkBox.appendChild(block);
        });
      }
      function applyPiece(acc, piece) {
        if (!piece) return acc;
        return acc + piece;
      }
      function readStream(res) {
        var reader = res.body.getReader();
        var decoder = new TextDecoder();
        var buffer = "";
        var acc = "";
        function pump() {
          return reader.read().then(function (step) {
            if (step.done) return acc;
            buffer += decoder.decode(step.value, { stream: true });
            var lines = buffer.split("\\n");
            buffer = lines.pop() || "";
            lines.forEach(function (line) {
              var trimmed = line.trim();
              if (trimmed.indexOf("data:") !== 0) return;
              var data = trimmed.slice(5).trim();
              if (!data || data === "[DONE]") return;
              var piece = data;
              try {
                var json = JSON.parse(data);
                piece = json.response || (json.choices && json.choices[0] && json.choices[0].delta && json.choices[0].delta.content) || "";
              } catch (e) {}
              acc = applyPiece(acc, piece);
              answer.textContent = acc;
            });
            return pump();
          });
        }
        return pump();
      }
      go.addEventListener("click", function () {
        var text = input.value.trim();
        if (!text) { status.textContent = "Send a question."; return; }
        if (!token) { status.textContent = "The check did not pass. Try again."; return; }
        var payload = JSON.stringify({ question: text, turnstileToken: token });
        token = "";
        if (window.turnstile && widgetId) window.turnstile.reset(widgetId);
        status.textContent = "Looking through the demo notes.";
        answer.textContent = "";
        var FRIENDLY = "Search is unavailable right now.";
        function fetchTimed(url, options) {
          var ctrl = new AbortController();
          var timer = setTimeout(function () { ctrl.abort(); }, 20000);
          return fetch(url, Object.assign({}, options, { signal: ctrl.signal })).finally(function () { clearTimeout(timer); });
        }
        function messageFrom(body) {
          if (body && typeof body.error === "string" && body.error) {
            return body.resetsAt ? body.error + " Reset " + body.resetsAt + "." : body.error;
          }
          return FRIENDLY;
        }
        function readPayload(res) {
          return res.text().then(function (text) {
            var body = null;
            if (text) {
              try { body = JSON.parse(text); } catch (e) { body = null; }
            }
            return body;
          });
        }
        fetchTimed(ORIGIN + "/api/search", { method: "POST", headers: { "content-type": "application/json" }, body: payload })
          .then(function (res) {
            return readPayload(res).then(function (body) {
              if (!res.ok || !body) throw new Error(messageFrom(body));
              paintChunks(body.chunks || []);
            });
          })
          .then(function () {
            return fetchTimed(ORIGIN + "/api/ask", { method: "POST", headers: { "content-type": "application/json" }, body: payload });
          })
          .then(function (res) {
            var type = res.headers.get("content-type") || "";
            if (!res.ok || type.indexOf("application/json") !== -1) {
              return readPayload(res).then(function (body) { throw new Error(messageFrom(body)); });
            }
            return readStream(res);
          })
          .then(function () { status.textContent = "Answered from the indexed notes."; })
          .catch(function (err) {
            if (err && err.name === "AbortError") status.textContent = FRIENDLY;
            else status.textContent = err instanceof Error && err.message ? err.message : FRIENDLY;
          });
      });
    })();`;
