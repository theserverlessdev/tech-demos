# Changelog

## 0.1.0

- One `@cf/cloudflare/clef-omni` call returns a probability for every allowed answer on a photo, a WAV or MP3, or a short MP4 or WebM.
- Phone capture (photo, voice note, up to 10 seconds of video), a file input, and five self-made samples.
- Preset checklists and custom questions, up to five questions with two to six options.
- Comparison mode times Whisper or Llama 3.2 11B Vision, then Clef, on the same image or audio. Video has no classic-chain pass.
- R2 objects are owner-only (visitor cookie, CORP same-origin, noindex, sandbox CSP) and a cron deletes them after 24 hours.
- D1 enforces a visitor cap, a network cap (HMAC of the IPv4 or IPv6 /64), and a rolling daily cap in one insert.
- Turnstile before any model call. `ENVIRONMENT=local` uses a labelled stub and does not call Workers AI.
