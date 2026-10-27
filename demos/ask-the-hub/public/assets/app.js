(function () {
  var SAMPLES = [
    "What does the R2 Drive demo prove?",
    "Which demos use Turnstile?",
    "How does Clairic Intake handle a null field?",
    "What could I build with docs search?",
  ];
  var SITE_KEY = "0x4AAAAAAFRUoj5qDpf7XyIW";
  var widgetId = "";
  var token = "";

  var question = document.getElementById("question");
  var form = document.getElementById("form");
  var ask = document.getElementById("ask");
  var answer = document.getElementById("answer");
  var chunks = document.getElementById("chunks");
  var status = document.getElementById("status");
  var chips = document.getElementById("chips");

  document.getElementById("theme").addEventListener("click", function () {
    var next = document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light";
    document.documentElement.setAttribute("data-theme", next);
    try { localStorage.setItem("theme", next); } catch (e) {}
  });

  SAMPLES.forEach(function (sample) {
    var button = document.createElement("button");
    button.type = "button";
    button.className = "chip";
    button.textContent = sample;
    button.addEventListener("click", function () {
      question.value = sample;
      question.focus();
    });
    chips.appendChild(button);
  });

  function setStatus(text) {
    status.textContent = text;
  }

  function renderChunks(list) {
    chunks.replaceChildren();
    if (!list || !list.length) {
      var empty = document.createElement("p");
      empty.className = "muted";
      empty.textContent = "No matching notes came back.";
      chunks.appendChild(empty);
      return;
    }
    list.forEach(function (item) {
      var article = document.createElement("article");
      article.className = "chunk";
      var meta = document.createElement("p");
      meta.className = "chunk__meta";
      var source = document.createElement("span");
      source.textContent = item.source || "document";
      var score = document.createElement("span");
      score.textContent = Number(item.score || 0).toFixed(2);
      meta.append(source, score);
      var snip = document.createElement("p");
      snip.textContent = item.snippet || "";
      article.append(meta, snip);
      chunks.appendChild(article);
    });
  }

  function applyPiece(acc, piece) {
    if (!piece) return acc;
    return acc + piece;
  }

  async function readStream(res, onText) {
    var type = res.headers.get("content-type") || "";
    var reader = res.body.getReader();
    var decoder = new TextDecoder();
    var buffer = "";
    var acc = "";
    var sse = type.indexOf("text/event-stream") !== -1;
    while (true) {
      var step = await reader.read();
      if (step.done) break;
      var chunk = decoder.decode(step.value, { stream: true });
      if (!sse && chunk.indexOf("data:") === -1) {
        acc += chunk;
        onText(acc);
        continue;
      }
      sse = true;
      buffer += chunk;
      var lines = buffer.split("\n");
      buffer = lines.pop() || "";
      lines.forEach(function (line) {
        var trimmed = line.trim();
        if (trimmed.indexOf("data:") !== 0) return;
        var data = trimmed.slice(5).trim();
        if (!data || data === "[DONE]") return;
        var piece = data;
        try {
          var json = JSON.parse(data);
          piece = json.response || (json.choices && json.choices[0] && ((json.choices[0].delta && json.choices[0].delta.content) || (json.choices[0].message && json.choices[0].message.content))) || "";
        } catch (e) {}
        acc = applyPiece(acc, piece);
        onText(acc);
      });
    }
    return acc;
  }

  var configReady = false;
  function mountTurnstile() {
    if (!configReady) return false;
    var host = document.getElementById("turnstile");
    var api = window.turnstile;
    if (!host || host.dataset.ready === "1") return true;
    if (!api || typeof api.render !== "function") return false;
    host.dataset.ready = "1";
    widgetId = api.render(host, {
      sitekey: SITE_KEY,
      action: "ask-the-hub",
      callback: function (value) { token = value; },
      "expired-callback": function () { token = ""; },
      "error-callback": function () { token = ""; },
    });
    return true;
  }

  fetch("/api/config")
    .then(function (res) { return res.ok ? res.json() : null; })
    .then(function (config) {
      if (!config || !config.siteKey) return;
      SITE_KEY = config.siteKey;
      configReady = true;
      if (mountTurnstile()) return;
      var tries = 0;
      var timer = setInterval(function () {
        tries += 1;
        if (mountTurnstile() || tries >= 20) clearInterval(timer);
      }, 200);
    })
    .catch(function () {});

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    var text = question.value.trim();
    if (!text) {
      setStatus("Send a question.");
      return;
    }
    if (text.length > 500) {
      setStatus("Keep the question to 500 characters.");
      return;
    }
    if (!token) {
      setStatus("The check did not pass. Try again.");
      return;
    }
    ask.disabled = true;
    answer.textContent = "";
    setStatus("Looking through the demo notes.");
    var payload = JSON.stringify({ question: text, turnstileToken: token });
    token = "";
    if (window.turnstile && widgetId) window.turnstile.reset(widgetId);

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

    var search = fetchTimed("/api/search", { method: "POST", headers: { "content-type": "application/json" }, body: payload })
      .then(function (res) {
        return readPayload(res).then(function (body) {
          if (!res.ok || !body) throw new Error(messageFrom(body));
          renderChunks(body.chunks || []);
        });
      });

    var stream = search.then(function () {
      return fetchTimed("/api/ask", { method: "POST", headers: { "content-type": "application/json" }, body: payload });
    }).then(function (res) {
      var type = res.headers.get("content-type") || "";
      if (!res.ok || type.indexOf("application/json") !== -1) {
        return readPayload(res).then(function (body) {
          throw new Error(messageFrom(body));
        });
      }
      return readStream(res, function (textSoFar) { answer.textContent = textSoFar; });
    });

    Promise.all([search, stream])
      .then(function () { setStatus("Answered from the indexed notes."); })
      .catch(function (err) {
        if (err && err.name === "AbortError") setStatus(FRIENDLY);
        else setStatus(err instanceof Error && err.message ? err.message : FRIENDLY);
      })
      .finally(function () { ask.disabled = false; });
  });
})();
