import { expect, test } from "bun:test";
import { parseClientSignal, summarizeSignal } from "./signal";

const SDP = "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n";

test("offers, answers, and ICE candidates pass, and file-shaped messages do not", () => {
  const offer = parseClientSignal(JSON.stringify({ type: "offer", sdp: SDP }));
  expect(offer.ok).toBe(true);
  const answer = parseClientSignal(JSON.stringify({ type: "answer", sdp: SDP }));
  expect(answer.ok).toBe(true);
  const candidate = "candidate:1 1 UDP 2122252543 203.0.113.8 54521 typ srflx raddr 10.0.0.8 rport 54521";
  const ice = parseClientSignal(JSON.stringify({ type: "candidate", candidate, sdpMid: "0", sdpMLineIndex: 0 }));
  expect(ice.ok).toBe(true);
  if (!ice.ok) return;
  const summary = summarizeSignal(ice.signal, ice.bytes);
  expect(summary.summary).toContain("ice · srflx");
  expect(summary.summary).not.toContain("203.0.113.8");
  expect(summary.summary).not.toContain("10.0.0.8");

  const fileish = parseClientSignal(JSON.stringify({ type: "offer", sdp: SDP, sha256: "abc", name: "secret.bin" }));
  expect(fileish.ok).toBe(false);
  expect(parseClientSignal(JSON.stringify({ type: "meta", name: "a.bin", size: 4 })).ok).toBe(false);
  expect(parseClientSignal("not json").ok).toBe(false);
  expect(parseClientSignal(JSON.stringify({ type: "offer", sdp: "v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n" })).ok).toBe(false);
});

test("a signalling summary never includes the SDP body", () => {
  const parsed = parseClientSignal(JSON.stringify({ type: "offer", sdp: SDP }));
  if (!parsed.ok) throw new Error("offer");
  const summary = summarizeSignal(parsed.signal, parsed.bytes);
  expect(summary.kind).toBe("offer");
  expect(summary.summary).toContain("sdp lines");
  expect(summary.summary).not.toContain("webrtc-datachannel");
  expect(summary.summary).not.toContain("127.0.0.1");
});

test("oversized signalling is rejected", () => {
  const huge = JSON.stringify({ type: "candidate", candidate: `candidate:${"a".repeat(20_000)}` });
  const parsed = parseClientSignal(huge);
  expect(parsed.ok).toBe(false);
  if (parsed.ok) return;
  expect(parsed.reason).toBe("too-large");
});
