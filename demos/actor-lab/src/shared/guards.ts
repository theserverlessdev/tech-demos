export const BODY_MAX = 32_000;
export const FRAME_WINDOW_MS = 10_000;
export const FRAME_MAX = 20;
export const SAYS_PER_MINUTE = 30;
export const SAY_WINDOW_MS = 60_000;
export const SCRATCH_COALESCE_MS = 80;
export const SCRATCH_MIN_INTERVAL_MS = 1_000;
export const SCRATCH_SOCKET_MAX = 12;
export const SCRATCH_SOCKET_WINDOW_MS = 10_000;
export const RECONNECT_MAX = 5;
export const RESERVED_NAMES = new Set(["actor"]);

export const TURNSTILE_RACE = "race-arm";
export const TURNSTILE_UNLOCK = "chat-unlock";

export const ALLOWED_TURNSTILE_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "[::1]",
  "tech-demos.theserverless.dev",
  "actor-lab.tech-demos.theserverless.dev",
]);

export function hostAllowed(host: string): boolean {
  return ALLOWED_TURNSTILE_HOSTS.has(host);
}

export function isReservedName(name: string): boolean {
  return RESERVED_NAMES.has(name.trim().toLowerCase());
}

export function admitFrame(frames: number[], now: number): { ok: boolean; frames: number[] } {
  const next = frames.filter((at) => now - at < FRAME_WINDOW_MS);
  next.push(now);
  return { ok: next.length <= FRAME_MAX, frames: next };
}

export function admitSay(says: number[], now: number): { ok: boolean; says: number[] } {
  const next = says.filter((at) => now - at < SAY_WINDOW_MS);
  if (next.length >= SAYS_PER_MINUTE) return { ok: false, says: next };
  next.push(now);
  return { ok: true, says: next };
}

export function admitScratch(frames: number[], now: number): { ok: boolean; frames: number[] } {
  const next = frames.filter((at) => now - at < SCRATCH_SOCKET_WINDOW_MS);
  if (next.length >= SCRATCH_SOCKET_MAX) return { ok: false, frames: next };
  next.push(now);
  return { ok: true, frames: next };
}

export function nextScratchWait(lastAt: number, now: number, min = SCRATCH_MIN_INTERVAL_MS): number {
  if (lastAt <= 0) return 0;
  return Math.max(0, min - (now - lastAt));
}

export function clipSpeakerName(role: "human" | "actor", name: string): string {
  return role === "actor" ? "Actor" : name;
}

export function shouldReconnect(code: number, attempt: number, max = RECONNECT_MAX): boolean {
  if (code === 1001) return false;
  return attempt < max;
}

export function turnstileActionOk(got: string | undefined, expected: string): boolean {
  return got === expected;
}

export function livePeers(sockets: { readyState: number }[], except?: object): number {
  return sockets.filter((ws) => ws !== except && ws.readyState === 1).length;
}

export function contentLengthTooLarge(request: Request, max = BODY_MAX): boolean {
  const raw = request.headers.get("content-length");
  if (raw == null || raw === "") return false;
  const n = Number(raw);
  return Number.isFinite(n) && n > max;
}

export function isTurnstileApi(value: unknown): value is { render: (...args: never[]) => unknown } {
  if (!value || typeof value !== "object") return false;
  if ("nodeType" in value) return false;
  return typeof (value as { render?: unknown }).render === "function";
}
