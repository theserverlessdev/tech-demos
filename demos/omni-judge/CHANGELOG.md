# Changelog

## 0.1.7

- A `sidx` inside any box outside `mdat` counts toward the presentation span, including a top-level `stbl`, `minf`, `mdia`, or `sinf`. The box walk that looks for it shares the 50,000 box cap.

## 0.1.6

- A WebM cut-tail is kept only when no Cluster id follows the broken element. A junk byte after the header no longer hides the rest of the file, and a cut inside a BlockGroup still keeps the last complete block.
- `sidx` contributes a presentation span, including a box nested in `moov` or `udta`, instead of a sum across tracks. A fragment with no `tfdt` next to a `sidx` is rejected.
- Composition time is the span from the earliest presentation to the latest end, so a B-frame delay is not added and a negative offset cannot hide a long file. `trex` still supplies a sample duration when a `trun` only has composition offsets. A one-tick sample table must match the chunk table.

## 0.1.5

- A WebM cut-tail is kept only when the broken element is the last bytes of the file. A short edit in the middle of a cluster, or bytes after a shrunk Segment, is rejected.
- MP4 duration includes the `sidx` subsegment sum, composition offsets, and the span across `trun`s that share a `tfdt`. An 8 second fragment whose decode time does not start at zero still passes.

## 0.1.4

- A broken WebM element, a second Info, or an unknown-size Info is rejected instead of keeping a short prefix. A cut-off cluster keeps the last complete block.
- MP4 duration includes the edit list and the `tfdt` timeline, so a repeated edit or a decode-time jump cannot hide a long file. A stock `frag_every_frame` file still passes.
- MP3 duration no longer adds a millisecond to an exact whole number. Photos with alpha fall back to PNG when the browser cannot encode WebP.

## 0.1.3

- Fragmented MP4 duration sums every `trun` on a track, then adds that track's `stts` ticks. A 9.5 second Chrome-style file stays inside the cap, and a 50 second file does not.
- MP3 duration rounds up, so a file past 15 seconds cannot report exactly 15. WAV keeps the first `fmt ` and requires it before the data.
- An unknown-size WebM cluster ends at the next segment element. A sample count that does not fit in the box is rejected.

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
