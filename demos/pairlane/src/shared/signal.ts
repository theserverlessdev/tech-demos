import { MAX_CANDIDATE_CHARS, MAX_SDP_CHARS, MAX_SIGNAL_BYTES, type TapeKind } from "./protocol";

export type ClientSignal =
  | { type: "offer"; sdp: string }
  | { type: "answer"; sdp: string }
  | { type: "candidate"; candidate: string; sdpMid: string | null; sdpMLineIndex: number | null };

export type ParseSignal =
  | { ok: true; signal: ClientSignal; bytes: number }
  | { ok: false; reason: string; bytes: number };

const encoder = new TextEncoder();

const ICE_ADDRESS = /^[A-Za-z0-9.:_-]{1,128}$/;

const ICE_EXT: Record<string, (value: string) => boolean> = {
  generation: (value) => /^\d{1,5}$/.test(value),
  ufrag: (value) => /^[A-Za-z0-9+/]{4,256}$/.test(value),
  "network-id": (value) => /^\d{1,5}$/.test(value),
  "network-cost": (value) => /^\d{1,5}$/.test(value),
  tcptype: (value) => /^(active|passive|so)$/.test(value),
};

function isPort(value: string): boolean {
  if (!/^\d{1,5}$/.test(value)) return false;
  const port = Number(value);
  return port <= 65535;
}

/** RFC 8839 candidate line, plus the short Chrome extensions we actually see. */
export function isIceCandidate(raw: string): boolean {
  if (raw.length < 16 || raw.length > MAX_CANDIDATE_CHARS) return false;
  if (!raw.startsWith("candidate:")) return false;
  const parts = raw.slice("candidate:".length).split(" ");
  if (parts.length < 8 || parts.length > 24) return false;
  const [foundation, component, transport, priority, address, port, typWord, typ, ...rest] = parts;
  if (!foundation || !/^[A-Za-z0-9+/]{1,32}$/.test(foundation)) return false;
  if (!component || !/^[1-9]\d{0,2}$/.test(component)) return false;
  if (!transport || !/^(udp|tcp)$/i.test(transport)) return false;
  if (!priority || !/^\d{1,10}$/.test(priority)) return false;
  if (!address || !ICE_ADDRESS.test(address)) return false;
  if (!port || !isPort(port)) return false;
  if (typWord !== "typ") return false;
  if (!typ || !/^(host|srflx|prflx|relay)$/.test(typ)) return false;
  let index = 0;
  let extensions = 0;
  while (index < rest.length) {
    const key = rest[index];
    if (!key) return false;
    if (key === "raddr") {
      const related = rest[index + 1];
      const word = rest[index + 2];
      const relatedPort = rest[index + 3];
      if (!related || !ICE_ADDRESS.test(related) || word !== "rport" || !relatedPort || !isPort(relatedPort)) return false;
      index += 4;
    } else {
      const check = ICE_EXT[key];
      const value = rest[index + 1];
      if (!check || value === undefined || !check(value)) return false;
      index += 2;
    }
    extensions += 1;
    if (extensions > 8) return false;
  }
  return true;
}

/** Accept offer, answer, or one ICE candidate. Anything else is not signalling. */
export function parseClientSignal(text: string): ParseSignal {
  const bytes = encoder.encode(text).byteLength;
  if (bytes > MAX_SIGNAL_BYTES) return { ok: false, reason: "too-large", bytes };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, reason: "not-json", bytes };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "not-object", bytes };
  }
  const record = value as Record<string, unknown>;
  const type = record.type;
  const keys = Object.keys(record);
  if (type === "candidate") {
    if (keys.some((key) => key !== "type" && key !== "candidate" && key !== "sdpMid" && key !== "sdpMLineIndex")) {
      return { ok: false, reason: "extra-fields", bytes };
    }
    const candidate = record.candidate;
    if (typeof candidate !== "string" || !isIceCandidate(candidate)) {
      return { ok: false, reason: "bad-candidate", bytes };
    }
    const sdpMid = record.sdpMid;
    const sdpMLineIndex = record.sdpMLineIndex;
    if (sdpMid !== null && (typeof sdpMid !== "string" || sdpMid.length > 32 || !/^[A-Za-z0-9_+/-]*$/.test(sdpMid))) {
      return { ok: false, reason: "bad-candidate", bytes };
    }
    if (
      sdpMLineIndex !== null &&
      (typeof sdpMLineIndex !== "number" || !Number.isInteger(sdpMLineIndex) || sdpMLineIndex < 0 || sdpMLineIndex > 16)
    ) {
      return { ok: false, reason: "bad-candidate", bytes };
    }
    if (sdpMid == null && sdpMLineIndex == null) return { ok: false, reason: "bad-candidate", bytes };
    return { ok: true, signal: { type: "candidate", candidate, sdpMid, sdpMLineIndex }, bytes };
  }
  if (type !== "offer" && type !== "answer") return { ok: false, reason: "unknown-type", bytes };
  if (keys.some((key) => key !== "type" && key !== "sdp")) return { ok: false, reason: "extra-fields", bytes };
  const sdp = record.sdp;
  if (typeof sdp !== "string" || sdp.length < 8 || sdp.length > MAX_SDP_CHARS) {
    return { ok: false, reason: "bad-sdp", bytes };
  }
  if (!sdp.startsWith("v=0")) return { ok: false, reason: "bad-sdp", bytes };
  if (!sdp.includes("m=application")) return { ok: false, reason: "bad-sdp", bytes };
  return { ok: true, signal: { type, sdp }, bytes };
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${Math.round(bytes)} B`;
}

/** A one-line description safe to store. It never includes the SDP body or the candidate address. */
export function summarizeSignal(signal: ClientSignal, bytes: number): { kind: TapeKind; summary: string } {
  if (signal.type === "offer" || signal.type === "answer") {
    const lines = signal.sdp.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
    return { kind: signal.type, summary: `${signal.type} · ${lines} sdp lines · ${formatBytes(bytes)}` };
  }
  const typ = signal.candidate.match(/\btyp\s+([a-z0-9]+)/)?.[1] ?? "unknown";
  return { kind: "candidate", summary: `ice · ${typ} · ${formatBytes(bytes)}` };
}

export function signalRoleOk(role: "offerer" | "answerer", signal: ClientSignal): boolean {
  if (signal.type === "offer") return role === "offerer";
  if (signal.type === "answer") return role === "answerer";
  return true;
}
