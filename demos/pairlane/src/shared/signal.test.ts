import { expect, test } from "bun:test";
import { isIceCandidate, parseClientSignal, summarizeSignal } from "./signal";

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

test("ICE candidates match the candidate grammar and reject a tunnel", () => {
  const chrome = "candidate:842163049 1 udp 1677729535 192.168.1.2 53874 typ host generation 0 ufrag abcd network-id 1 network-cost 10";
  expect(isIceCandidate(chrome)).toBe(true);
  const mdns = "candidate:1 1 udp 2122260223 a1b2c3d4-e5f6-7890-abcd-ef1234567890.local 53874 typ host generation 0 ufrag abcd network-id 1";
  expect(isIceCandidate(mdns)).toBe(true);
  const tunnel = "candidate:1 1 udp 1 203.0.113.8 9 typ host hello secret payload";
  expect(isIceCandidate(tunnel)).toBe(false);
  const parsed = parseClientSignal(JSON.stringify({ type: "candidate", candidate: tunnel, sdpMid: "0", sdpMLineIndex: 0 }));
  expect(parsed.ok).toBe(false);
  const padded = `candidate:${"a".repeat(250)}`;
  const long = parseClientSignal(JSON.stringify({ type: "candidate", candidate: padded, sdpMid: "0", sdpMLineIndex: 0 }));
  expect(long.ok).toBe(false);
  if (long.ok) return;
  expect(long.reason).toBe("bad-candidate");
});

test("oversized signalling is rejected", () => {
  const huge = JSON.stringify({ type: "candidate", candidate: `candidate:${"a".repeat(20_000)}` });
  const parsed = parseClientSignal(huge);
  expect(parsed.ok).toBe(false);
  if (parsed.ok) return;
  expect(parsed.reason).toBe("too-large");
});
