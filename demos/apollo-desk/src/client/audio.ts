/** Browser stand-ins for the desk microphone and speaker. */

const WORKLET = `
class Capture extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor("apollo-capture", Capture);
`;

let shared: AudioContext | null = null;
export function audioContext(): AudioContext {
  shared ??= new AudioContext();
  if (shared.state === "suspended") void shared.resume();
  return shared;
}

/** Captures the microphone as 16 kHz mono s16le, the same format the ESP32 firmware sends. */
export class Mic {
  #stream: MediaStream | null = null;
  #node: AudioWorkletNode | null = null;
  #source: MediaStreamAudioSourceNode | null = null;
  #carry = new Float32Array(0);
  #active = false;
  level = 0;

  constructor(private onChunk: (pcm: ArrayBuffer) => void) {}

  get supported() {
    return !!navigator.mediaDevices?.getUserMedia && typeof AudioWorkletNode !== "undefined";
  }

  #moduleLoaded = false;

  async #ensure() {
    if (this.#node) return;
    const ctx = audioContext();
    this.#stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    if (!this.#moduleLoaded) {
      const url = URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" }));
      await ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      this.#moduleLoaded = true;
    }
    this.#source = ctx.createMediaStreamSource(this.#stream);
    this.#node = new AudioWorkletNode(ctx, "apollo-capture");
    const ratio = ctx.sampleRate / 16_000;
    this.#node.port.onmessage = (ev: MessageEvent<Float32Array>) => {
      if (!this.#active) return;
      const input = ev.data;
      let sum = 0;
      for (const s of input) sum += s * s;
      this.level = Math.min(1, Math.sqrt(sum / input.length) * 6);
      // Linear resample to 16 kHz, then convert to s16le.
      const joined = new Float32Array(this.#carry.length + input.length);
      joined.set(this.#carry);
      joined.set(input, this.#carry.length);
      const outLen = Math.floor(joined.length / ratio);
      const out = new Int16Array(outLen);
      for (let i = 0; i < outLen; i++) {
        const s = Math.max(-1, Math.min(1, joined[Math.floor(i * ratio)]!));
        out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      this.#carry = joined.slice(Math.floor(outLen * ratio));
      this.#pending.push(out);
      this.#pendingSamples += outLen;
      // Send about 100 ms at a time.
      if (this.#pendingSamples >= 1600) this.#flush();
    };
    this.#source.connect(this.#node);
    // The worklet writes no output, so this connection is silent. It makes sure the browser pulls the node.
    this.#node.connect(ctx.destination);
  }

  #pending: Int16Array[] = [];
  #pendingSamples = 0;

  #flush() {
    if (!this.#pendingSamples) return;
    const buf = new Int16Array(this.#pendingSamples);
    let o = 0;
    for (const p of this.#pending) {
      buf.set(p, o);
      o += p.length;
    }
    this.#pending = [];
    this.#pendingSamples = 0;
    this.onChunk(buf.buffer);
  }

  async start() {
    await this.#ensure();
    this.#carry = new Float32Array(0);
    this.#active = true;
  }

  /** Ends the hold and releases the microphone, so the browser stops showing it as in use. */
  stop() {
    this.#flush();
    this.#active = false;
    this.level = 0;
    this.#source?.disconnect();
    this.#node?.disconnect();
    if (this.#node) this.#node.port.onmessage = null;
    for (const track of this.#stream?.getTracks() ?? []) track.stop();
    this.#source = null;
    this.#node = null;
    this.#stream = null;
  }
}

/** Plays the WAV that the brain sends between tts_start and tts_end, and reports the output level for the mouth. */
export class Speaker {
  #gain: GainNode | null = null;
  #analyser: AnalyserNode | null = null;
  #source: AudioBufferSourceNode | null = null;
  #data = new Float32Array(1024);
  volume = 0.7;
  playing = false;
  /** Wall-clock time when the clip must be over. A watchdog uses it when the audio clock does not move. */
  endsAt = 0;
  #startedAt = 0;
  #startedCtxTime = 0;
  #queue: Uint8Array[] = [];
  #onIdle: (() => void) | null = null;
  #decoding = false;

  #chain() {
    const ctx = audioContext();
    if (!this.#gain) {
      this.#gain = ctx.createGain();
      this.#analyser = ctx.createAnalyser();
      this.#analyser.fftSize = 1024;
      this.#gain.connect(this.#analyser);
      this.#analyser.connect(ctx.destination);
    }
    this.#gain.gain.value = this.volume;
    return { ctx, gain: this.#gain };
  }

  setVolume(v: number) {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.#gain) this.#gain.gain.value = this.volume;
  }

  /** Queue one clip. `onIdle` runs when the queue is empty and the last clip has ended. */
  enqueue(bytes: Uint8Array, onIdle: () => void) {
    this.#queue.push(bytes);
    this.#onIdle = onIdle;
    this.playing = true;
    if (!this.#source && !this.#decoding) void this.#next();
  }

  async #next(): Promise<void> {
    const bytes = this.#queue.shift();
    this.endsAt = 0;
    if (!bytes) {
      this.playing = false;
      const onIdle = this.#onIdle;
      this.#onIdle = null;
      onIdle?.();
      return;
    }
    const { ctx, gain } = this.#chain();
    this.#decoding = true;
    let buffer: AudioBuffer;
    try {
      buffer = await ctx.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
    } catch {
      this.#decoding = false;
      return this.#next();
    }
    this.#decoding = false;
    if (!this.playing) return; // stop() ran while the clip decoded.
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(gain);
    src.onended = () => {
      if (this.#source !== src) return;
      this.#source = null;
      void this.#next();
    };
    this.#source = src;
    this.#startedAt = performance.now();
    this.#startedCtxTime = ctx.currentTime;
    this.endsAt = Date.now() + buffer.duration * 1000 + 1200;
    src.start();
  }

  /** Watchdog: end the current clip when its time is over but the browser sent no `ended` event. */
  skip() {
    const src = this.#source;
    this.#source = null;
    if (src) {
      src.onended = null;
      try {
        src.stop();
      } catch {
        // Already stopped.
      }
    }
    void this.#next();
  }

  stop() {
    this.#queue = [];
    this.#onIdle = null;
    this.playing = false;
    this.endsAt = 0;
    const src = this.#source;
    this.#source = null;
    if (src) {
      src.onended = null;
      try {
        src.stop();
      } catch {
        // Already stopped.
      }
    }
  }

  level(): number {
    if (!this.#source || !this.#analyser) return 0;
    // Without an output device the audio clock stays still and the analyser reads silence. Keep the mouth moving.
    if (performance.now() - this.#startedAt > 300 && audioContext().currentTime === this.#startedCtxTime) {
      const t = performance.now() / 1000;
      return this.volume > 0 ? 0.35 + 0.3 * Math.abs(Math.sin(t * 9) * Math.sin(t * 3.7)) : 0;
    }
    this.#analyser.getFloatTimeDomainData(this.#data);
    let sum = 0;
    for (const s of this.#data) sum += s * s;
    return Math.min(1, Math.sqrt(sum / this.#data.length) * 5);
  }
}

/** Upstream earcons: ding, chime, and error. */
export function playEffect(name: "ding" | "chime" | "error", volume: number) {
  if (volume <= 0) return;
  const ctx = audioContext();
  const notes = name === "ding" ? [[1318, 0]] : name === "chime" ? [[784, 0], [1175, 0.14]] : [[196, 0], [165, 0.16]];
  for (const [freq, at] of notes) {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = name === "error" ? "square" : "sine";
    osc.frequency.value = freq!;
    const t = ctx.currentTime + at!;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.18 * volume * (name === "error" ? 0.4 : 1), t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
    osc.connect(g).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.5);
  }
}
