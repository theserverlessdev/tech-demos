# Changelog

## 0.1.2

- The MP4 box walk stays inside the parent box, treats a zero size as that end, and stops after 50,000 boxes. `limits.cpu_ms` is 2000.
- An 8-byte all-ones EBML size is unknown, not a rejected integer. Chrome timeslice WebM and fMP4 durations read, including `trex` defaults.
- WebM duration is the block-timecode span, and TimecodeScale comes only from Segment > Info. MP3 resyncs and sums each frame's own rate. WAV sums every data chunk.
- Comparison images are capped at 512 KB and 2 megapixels. Media responses are private until `expires_at`, and a bad Range or a failed precondition returns 416 or 412.

## 0.1.1

- Video duration is read from WebM block timecodes and from fMP4 `mehd` or `trun`, so a browser recording is not rejected for a missing header.
- The demo host serves the API. The hub path redirects there. The visitor cookie is `__Host-oj_vid`.
- Media reads support Range, ignore expired rows, and use the stored content type.
- Phone capture shows a viewfinder, resizes photos, and stops video near 9.5 seconds.

## 0.1.0

- One `@cf/cloudflare/clef-omni` call returns a probability for every allowed answer on a photo, a WAV or MP3, or a short MP4 or WebM.
- Phone capture (photo, voice note, up to 10 seconds of video), a file input, and five self-made samples.
- Preset checklists and custom questions, up to five questions with two to six options.
- Comparison mode times Whisper or Llama 3.2 11B Vision, then Clef, on the same image or audio. Video has no classic-chain pass.
- R2 objects are owner-only (visitor cookie, CORP same-origin, noindex, sandbox CSP) and a cron deletes them after 24 hours.
- D1 enforces a visitor cap, a network cap (HMAC of the IPv4 or IPv6 /64), and a rolling daily cap in one insert.
- Turnstile before any model call. `ENVIRONMENT=local` uses a labelled stub and does not call Workers AI.
