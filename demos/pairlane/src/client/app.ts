import { classifyData, FILE_TOO_LARGE, joinParts, rateLabel, reduceRecv, safeName, sendFile, sha256Hex, type RecvState } from "../shared/file";
import { CID as CID_RE, MAX_FILE_BYTES, ROOM_ID as ROOM_RE, TURNSTILE_ACTION, type IceServer, type PublicConfig, type Role, type TapeEvent } from "../shared/protocol";
import { formatBytes } from "../shared/signal";
import { createPeerSession, type PeerSession } from "./peer";
import { clientBase, roomLink, socketUrl } from "./paths";
import { qrSvg } from "./qr";

const DUMMY = "XXXX.DUMMY.TOKEN.XXXX";

type StatusKind = "idle" | "wait" | "connecting" | "connected" | "sending" | "receiving" | "done" | "error";

function must<T extends Element>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node as unknown as T;
}

function setStatus(kind: StatusKind, text: string): void {
  const status = must<HTMLElement>("status");
  status.dataset.kind = kind;
  status.textContent = text;
}

function main(): void {
  const params = new URLSearchParams(location.search);
  if (params.get("preview") === "1") {
    showPreview();
    return;
  }
  const room = params.get("r");
  if (room && ROOM_RE.test(room)) void openRoom(room);
  else void openHome();
}

function showPreview(): void {
  must<HTMLElement>("home").hidden = true;
  const room = must<HTMLElement>("room");
  room.hidden = false;
  room.dataset.preview = "1";
  const link = roomLink("https://pairlane.tech-demos.theserverless.dev", "", "k7m2pqrs");
  must<HTMLElement>("qr").innerHTML = qrSvg(link);
  must<HTMLElement>("room-code").textContent = "k7m2pqrs";
  must<HTMLElement>("room-link").textContent = link;
  must<HTMLElement>("countdown").textContent = "9:40 left";
  setStatus("wait", "Layout preview. No room is open.");
  const file = must<HTMLInputElement>("file");
  file.disabled = false;
  must<HTMLElement>("file-label").classList.remove("is-disabled");
  const lines = [
    "join · offerer · signalling socket",
    "join · answerer · signalling socket",
    "offer · 12 sdp lines · 1.8 KB",
    "answer · 10 sdp lines · 1.4 KB",
    "ice · host · 96 B",
    "ice · srflx · 110 B",
  ];
  const tape = must<HTMLOListElement>("tape");
  tape.replaceChildren();
  for (const line of lines) {
    const item = document.createElement("li");
    item.textContent = line;
    tape.append(item);
  }
}

async function openHome(): Promise<void> {
  const config = await loadConfig();
  const tokenBox = { token: "" };
  const create = must<HTMLButtonElement>("create");
  const local = must<HTMLButtonElement>("local-check");
  local.addEventListener("click", () => {
    tokenBox.token = DUMMY;
    create.disabled = false;
    setFormError("");
  });
  create.addEventListener("click", () => {
    void createRoom(tokenBox.token);
  });
  if (config?.local) local.hidden = false;
  if (config?.siteKey) mountTurnstile(config.siteKey, tokenBox, create);
  must<HTMLFormElement>("join-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const code = must<HTMLInputElement>("join-code").value.trim().toLowerCase();
    if (!ROOM_RE.test(code)) {
      setFormError("Room codes are 8 letters.");
      return;
    }
    const url = new URL(location.href);
    url.search = `?r=${code}`;
    location.assign(url.toString());
  });
}

function setFormError(text: string): void {
  must<HTMLElement>("form-error").textContent = text;
}

async function loadConfig(): Promise<PublicConfig | null> {
  try {
    const res = await fetch(`${clientBase(location.pathname)}/api/config`);
    if (!res.ok) return null;
    return (await res.json()) as PublicConfig;
  } catch {
    return null;
  }
}

type TurnstileApi = {
  render: (el: string | HTMLElement, opts: Record<string, unknown>) => void;
};

function mountTurnstile(siteKey: string, tokenBox: { token: string }, create: HTMLButtonElement): void {
  const started = Date.now();
  const tick = () => {
    const api = (window as unknown as { turnstile?: TurnstileApi }).turnstile;
    if (typeof api?.render === "function") {
      try {
        api.render("#turnstile", {
          sitekey: siteKey,
          action: TURNSTILE_ACTION,
          callback: (token: string) => {
            tokenBox.token = token;
            create.disabled = false;
            setFormError("");
          },
          "expired-callback": () => {
            if (tokenBox.token === DUMMY) return;
            tokenBox.token = "";
            create.disabled = true;
          },
          "error-callback": () => {
            if (tokenBox.token === DUMMY) return;
            tokenBox.token = "";
            create.disabled = true;
            setFormError("The check could not load. Refresh the page.");
          },
        });
      } catch {
        setFormError("The check could not load. Use the local check.");
      }
      return;
    }
    if (Date.now() - started > 8000) {
      setFormError("The check could not load. Refresh the page.");
      return;
    }
    setTimeout(tick, 50);
  };
  tick();
}

function peerCid(): string {
  const key = "pairlane-cid";
  const existing = sessionStorage.getItem(key);
  if (existing && CID_RE.test(existing)) return existing;
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  let cid = "";
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  for (let i = 0; i < 12; i++) cid += alphabet[bytes[i]! % alphabet.length];
  sessionStorage.setItem(key, cid);
  return cid;
}

async function createRoom(token: string): Promise<void> {
  const create = must<HTMLButtonElement>("create");
  if (!token) {
    setFormError("Finish the check first.");
    return;
  }
  create.disabled = true;
  setFormError("");
  const cid = peerCid();
  let res: Response;
  try {
    res = await fetch(`${clientBase(location.pathname)}/api/rooms`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, creatorCid: cid }),
    });
  } catch {
    create.disabled = false;
    setFormError("The room could not be opened. Try again.");
    return;
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    setFormError(body?.error?.message ?? "The room could not be opened.");
    create.disabled = false;
    return;
  }
  const created = (await res.json()) as { id: string };
  const url = new URL(location.href);
  url.search = `?r=${created.id}`;
  location.assign(url.toString());
}

async function openRoom(id: string): Promise<void> {
  must<HTMLElement>("home").hidden = true;
  const section = must<HTMLElement>("room");
  section.hidden = false;
  const base = clientBase(location.pathname);
  const link = roomLink(location.origin, base, id);
  must<HTMLElement>("qr").innerHTML = qrSvg(link);
  must<HTMLElement>("room-code").textContent = id;
  const linkNode = must<HTMLElement>("room-link");
  linkNode.textContent = link;
  let savedUrl = "";
  const save = must<HTMLAnchorElement>("save");
  save.addEventListener("click", () => {
    const url = savedUrl;
    if (!url) return;
    window.setTimeout(() => {
      if (savedUrl !== url) return;
      URL.revokeObjectURL(url);
      savedUrl = "";
      save.removeAttribute("href");
    }, 1500);
  });
  must<HTMLButtonElement>("copy-link").addEventListener("click", () => {
    const copied = must<HTMLElement>("copied");
    void navigator.clipboard.writeText(link).then(
      () => {
        copied.hidden = false;
        copied.textContent = "Link copied.";
      },
      () => {
        copied.hidden = false;
        copied.textContent = "Copy failed. Select the link instead.";
      },
    );
  });
  setStatus("connecting", "Connecting to the signalling room…");
  const cid = peerCid();
  const ws = new WebSocket(socketUrl(location.protocol, location.host, base, id, cid));
  let role: Role | null = null;
  let session: PeerSession | null = null;
  let channel: RTCDataChannel | null = null;
  let recv: RecvState = { phase: "idle" };
  let sending = false;
  let ignoreBody = false;
  let sentBytes = 0;
  let sentTotal = 0;
  let sentElapsed = 0;
  let expiresAt = 0;
  const seen = new Set<number>();
  const turnOn = { value: false };

  const timer = window.setInterval(() => {
    if (!expiresAt) return;
    const left = expiresAt - Date.now();
    must<HTMLElement>("countdown").textContent = left <= 0 ? "Expired" : `${formatLeft(left)} left`;
    if (left <= 0) setStatus("error", "This room has expired.");
  }, 1000);

  function addTape(event: TapeEvent): void {
    if (seen.has(event.n)) return;
    seen.add(event.n);
    const item = document.createElement("li");
    const clock = new Date(event.at).toISOString().slice(11, 19);
    item.textContent = `${clock}  ${event.summary}`;
    const tape = must<HTMLOListElement>("tape");
    tape.append(item);
    tape.scrollTop = tape.scrollHeight;
  }

  function bindChannel(next: RTCDataChannel): void {
    channel = next;
    next.binaryType = "arraybuffer";
    const file = must<HTMLInputElement>("file");
    file.disabled = false;
    must<HTMLElement>("file-label").classList.remove("is-disabled");
    setStatus("connected", "Connected. Pick a file.");
    next.onmessage = (event) => {
      void onChannelMessage(event.data);
    };
    next.onclose = () => {
      file.disabled = true;
      must<HTMLElement>("file-label").classList.add("is-disabled");
    };
  }

  async function onChannelMessage(data: unknown): Promise<void> {
    if (!channel) return;
    const payload = typeof data === "string" ? data : data instanceof ArrayBuffer ? data : null;
    if (payload === null) return;
    const kind = classifyData(payload);
    if (kind.kind === "reject") {
      sending = false;
      must<HTMLInputElement>("file").disabled = false;
      setStatus("error", kind.reason);
      return;
    }
    if (kind.kind === "oversize") {
      ignoreBody = true;
      channel.send(JSON.stringify({ type: "reject", reason: FILE_TOO_LARGE }));
      recv = { phase: "idle" };
      setStatus("error", FILE_TOO_LARGE);
      return;
    }
    if (ignoreBody && (kind.kind === "chunk" || kind.kind === "done")) return;
    if (kind.kind === "meta") ignoreBody = false;
    if (kind.kind === "ack") {
      sending = false;
      must<HTMLInputElement>("file").disabled = false;
      if (kind.ok) setProgress(sentBytes, sentTotal, `Sent · ${rateLabel(sentBytes, sentElapsed)}`);
      setStatus(kind.ok ? "done" : "error", kind.ok ? "The other browser has the file. SHA-256 matches." : "The other browser could not verify the file.");
      return;
    }
    if (kind.kind === "busy") {
      setStatus("connected", "The other browser is sending. Wait for it to finish.");
      return;
    }
    if (sending && (kind.kind === "meta" || kind.kind === "chunk" || kind.kind === "done")) {
      channel.send(JSON.stringify({ type: "busy" }));
      return;
    }
    recv = reduceRecv(recv, payload);
    if (recv.phase === "body") {
      setStatus("receiving", `${safeName(recv.meta.name)} · ${formatBytes(recv.got)} / ${formatBytes(recv.meta.size)}`);
      setProgress(recv.got, recv.meta.size, "Receiving");
    }
    if (recv.phase === "error") {
      setStatus("error", recv.reason);
      recv = { phase: "idle" };
      return;
    }
    if (recv.phase === "done") {
      const done = recv;
      recv = { phase: "idle" };
      const bytes = joinParts(done.parts, done.meta.size);
      const hash = await sha256Hex(bytes);
      const ok = hash === done.meta.sha256;
      channel.send(JSON.stringify({ type: "ack", ok }));
      if (!ok) {
        setStatus("error", "SHA-256 did not match. The file was not saved.");
        return;
      }
      const blob = new Blob([bytes], { type: done.meta.mime });
      if (savedUrl) URL.revokeObjectURL(savedUrl);
      savedUrl = URL.createObjectURL(blob);
      save.href = savedUrl;
      save.download = done.meta.name;
      save.hidden = false;
      save.textContent = `Save ${done.meta.name}`;
      setProgress(done.meta.size, done.meta.size, "Received");
      setStatus("done", `${done.meta.name} is ready to save. SHA-256 matches.`);
    }
  }

  ws.onmessage = (event) => {
    const msg = JSON.parse(String(event.data)) as {
      type: string;
      role?: Role;
      peers?: number;
      ready?: boolean;
      expiresAt?: number;
      tape?: TapeEvent[];
      iceServers?: IceServer[];
      event?: TapeEvent;
      sdp?: string;
      candidate?: string;
      sdpMid?: string | null;
      sdpMLineIndex?: number | null;
    };
    if (msg.type === "hello" && msg.role && msg.expiresAt && msg.iceServers && msg.tape) {
      role = msg.role;
      expiresAt = msg.expiresAt;
      turnOn.value = msg.iceServers.length > 1;
      must<HTMLElement>("peer-count").textContent = `${msg.peers ?? 1} / 2`;
      for (const item of msg.tape) addTape(item);
      session = createPeerSession({
        role,
        iceServers: msg.iceServers,
        sendSignal: (signal) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(signal));
        },
        onChannel: bindChannel,
        onConnection: (state) => {
          if (state === "failed") {
            const hint = turnOn.value
              ? "The browsers could not open a direct path."
              : "No direct path. TURN is optional and not configured.";
            setStatus("error", hint);
          }
        },
      });
      setStatus("wait", "Waiting for the other device");
      return;
    }
    if (msg.type === "tape" && msg.event) {
      addTape(msg.event);
      return;
    }
    if (msg.type === "peer") {
      must<HTMLElement>("peer-count").textContent = `${msg.peers ?? 0} / 2`;
      if (msg.ready && role === "offerer") {
        setStatus("connecting", "Exchanging signalling…");
        void session?.startOffer();
      } else if (!msg.ready) {
        session?.close();
        channel = null;
        must<HTMLInputElement>("file").disabled = true;
        must<HTMLElement>("file-label").classList.add("is-disabled");
        setStatus("wait", "Waiting for the other device");
      }
      return;
    }
    if (msg.type === "offer" && msg.sdp) {
      setStatus("connecting", "Exchanging signalling…");
      void session?.acceptOffer(msg.sdp);
      return;
    }
    if (msg.type === "answer" && msg.sdp) {
      void session?.acceptAnswer(msg.sdp);
      return;
    }
    if (msg.type === "candidate" && msg.candidate) {
      void session?.addCandidate(msg.candidate, msg.sdpMid ?? null, msg.sdpMLineIndex ?? null);
      return;
    }
    if (msg.type === "expired") {
      window.clearInterval(timer);
      setStatus("error", "This room has expired.");
    }
  };

  ws.onclose = (event) => {
    window.clearInterval(timer);
    if (event.code === 4002) setStatus("error", "This room already has two peers.");
    else if (event.code === 4001) setStatus("error", "This room has expired.");
    else if (event.code === 4003) setStatus("error", "This room is open in a newer tab.");
    else if (event.code === 4008) setStatus("error", "Signalling stopped after too many messages.");
    else if (must<HTMLElement>("status").dataset.kind !== "done") setStatus("error", "The signalling connection closed.");
  };

  const file = must<HTMLInputElement>("file");
  const label = must<HTMLElement>("file-label");
  file.addEventListener("change", () => {
    const picked = file.files?.[0];
    if (picked) void ship(picked);
    file.value = "";
  });
  label.addEventListener("dragover", (event) => {
    event.preventDefault();
    label.classList.add("is-hot");
  });
  label.addEventListener("dragleave", () => label.classList.remove("is-hot"));
  label.addEventListener("drop", (event) => {
    event.preventDefault();
    label.classList.remove("is-hot");
    const picked = (event as DragEvent).dataTransfer?.files?.[0];
    if (picked) void ship(picked);
  });

  async function ship(picked: File): Promise<void> {
    if (!channel || channel.readyState !== "open" || sending) return;
    if (picked.size > MAX_FILE_BYTES) {
      setStatus("error", FILE_TOO_LARGE);
      return;
    }
    sending = true;
    file.disabled = true;
    setStatus("sending", `Sending ${safeName(picked.name)}`);
    try {
      await sendFile(channel, picked, {
        onProgress: (sent, total, elapsed) => {
          sentBytes = sent;
          sentTotal = total;
          sentElapsed = elapsed;
          setProgress(sent, total, `Sending · ${rateLabel(sent, elapsed)}`);
        },
      });
      setStatus("sending", "Waiting for the other browser to check SHA-256.");
    } catch {
      sending = false;
      file.disabled = false;
      setStatus("error", "The send stopped before the file finished.");
    }
  }
}

function setProgress(sent: number, total: number, label: string): void {
  const wrap = must<HTMLElement>("progress");
  wrap.hidden = false;
  const pct = total === 0 ? 100 : Math.min(100, Math.round((sent / total) * 100));
  must<HTMLElement>("progress-fill").style.width = `${pct}%`;
  must<HTMLElement>("progress-label").textContent = `${label} · ${formatBytes(sent)} / ${formatBytes(total)}`;
}

function formatLeft(ms: number): string {
  const total = Math.ceil(ms / 1000);
  const min = Math.floor(total / 60);
  const sec = total % 60;
  return `${min}:${sec.toString().padStart(2, "0")}`;
}

main();
