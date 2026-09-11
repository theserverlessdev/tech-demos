import { metered, PRICES } from "./meter";

export const MIC_SAMPLE_RATE = 16_000;
/** Upstream drops holds under 8,000 bytes (0.25 s). */
export const MIN_AUDIO_BYTES = 8_000;
/** 15 s of 16 kHz s16le mono. */
export const MAX_AUDIO_BYTES = 15 * MIC_SAMPLE_RATE * 2;
/** Binary frame size for TTS audio going down to the desk. */
export const TTS_FRAME_BYTES = 32_768;

/** Upstream adds the WAV header on the server before STT. This does the same. */
export function pcmToWav(chunks: Uint8Array[], sampleRate = MIC_SAMPLE_RATE): Uint8Array {
  const dataLength = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(44 + dataLength);
  const view = new DataView(out.buffer);
  const ascii = (offset: number, s: string) => [...s].forEach((ch, i) => view.setUint8(offset + i, ch.charCodeAt(0)));
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataLength, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, dataLength, true);
  let offset = 44;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export async function transcribe(env: Env, wav: Uint8Array): Promise<{ text: string; seconds: number }> {
  const seconds = (wav.byteLength - 44) / (MIC_SAMPLE_RATE * 2);
  const out = await metered(
    env,
    (seconds / 60) * PRICES.sttMinute,
    () => env.AI.run(env.STT_MODEL, { audio: toBase64(wav), language: "en", vad_filter: true }),
    () => (seconds / 60) * PRICES.sttMinute,
  );
  return { text: String((out as { text?: string }).text ?? "").trim(), seconds };
}

/** Text for the speaker: no markdown, no emoji, and one upstream segment in length. */
export function speakable(text: string): string {
  return text
    .replace(/[*_`#>~]/g, "")
    .replace(/\[(.*?)\]\((.*?)\)/g, "$1")
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);
}

export async function synthesize(env: Env, text: string): Promise<Uint8Array | null> {
  const prompt = speakable(text);
  if (!prompt) return null;
  // MeloTTS speaks about 15 characters each second.
  const estimate = (prompt.length / 15 / 60) * PRICES.ttsMinute;
  const out = await metered(
    env,
    estimate,
    () => env.AI.run(env.TTS_MODEL, { prompt, lang: "en" }),
    () => estimate,
  );
  const audio = (out as { audio?: string }).audio;
  return audio ? fromBase64(audio) : null;
}
