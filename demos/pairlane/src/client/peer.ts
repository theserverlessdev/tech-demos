import type { IceServer, Role } from "../shared/protocol";
import type { ClientSignal } from "../shared/signal";

export type PeerSession = {
  startOffer(): Promise<void>;
  acceptOffer(sdp: string): Promise<void>;
  acceptAnswer(sdp: string): Promise<void>;
  addCandidate(candidate: string, sdpMid: string | null, sdpMLineIndex: number | null): Promise<void>;
  close(): void;
  channel(): RTCDataChannel | null;
};

type RemoteIce = { candidate: string; sdpMid: string | null; sdpMLineIndex: number | null };

export function createPeerSession(opts: {
  role: Role;
  iceServers: IceServer[];
  sendSignal: (signal: ClientSignal) => void;
  onChannel: (channel: RTCDataChannel) => void;
  onConnection: (state: RTCPeerConnectionState) => void;
}): PeerSession {
  let pc: RTCPeerConnection | null = null;
  let dc: RTCDataChannel | null = null;
  let remoteSet = false;
  const pending: RemoteIce[] = [];
  let generation = 0;

  function rtcServers(): RTCIceServer[] {
    return opts.iceServers.map((server) => ({
      urls: server.urls,
      username: server.username,
      credential: server.credential,
    }));
  }

  function ensure(): RTCPeerConnection {
    if (pc && pc.connectionState !== "closed") return pc;
    const gen = ++generation;
    remoteSet = false;
    dc = null;
    const next = new RTCPeerConnection({ iceServers: rtcServers() });
    pc = next;
    next.onicecandidate = (event) => {
      if (gen !== generation) return;
      const found = event.candidate;
      if (!found?.candidate) return;
      opts.sendSignal({
        type: "candidate",
        candidate: found.candidate,
        sdpMid: found.sdpMid,
        sdpMLineIndex: found.sdpMLineIndex,
      });
    };
    next.onconnectionstatechange = () => {
      if (gen !== generation) return;
      opts.onConnection(next.connectionState);
    };
    next.ondatachannel = (event) => {
      if (gen !== generation) return;
      adopt(event.channel);
    };
    return next;
  }

  function adopt(channel: RTCDataChannel): void {
    dc = channel;
    channel.binaryType = "arraybuffer";
    if (channel.readyState === "open") opts.onChannel(channel);
    else channel.onopen = () => opts.onChannel(channel);
  }

  async function flush(current: RTCPeerConnection): Promise<void> {
    if (!remoteSet) return;
    while (pending.length > 0) {
      const ice = pending.shift();
      if (!ice) continue;
      await current.addIceCandidate(ice);
    }
  }

  return {
    channel: () => dc,
    close() {
      generation += 1;
      dc = null;
      remoteSet = false;
      pending.length = 0;
      pc?.close();
      pc = null;
    },
    async startOffer() {
      if (opts.role !== "offerer") return;
      if (pc && pc.connectionState !== "closed" && dc) return;
      const current = ensure();
      const channel = current.createDataChannel("file", { ordered: true });
      adopt(channel);
      const offer = await current.createOffer();
      await current.setLocalDescription(offer);
      const sdp = current.localDescription?.sdp;
      if (sdp) opts.sendSignal({ type: "offer", sdp });
    },
    async acceptOffer(sdp: string) {
      const current = ensure();
      await current.setRemoteDescription({ type: "offer", sdp });
      remoteSet = true;
      const answer = await current.createAnswer();
      await current.setLocalDescription(answer);
      const local = current.localDescription?.sdp;
      if (local) opts.sendSignal({ type: "answer", sdp: local });
      await flush(current);
    },
    async acceptAnswer(sdp: string) {
      const current = pc;
      if (!current) return;
      await current.setRemoteDescription({ type: "answer", sdp });
      remoteSet = true;
      await flush(current);
    },
    async addCandidate(candidate: string, sdpMid: string | null, sdpMLineIndex: number | null) {
      const ice = { candidate, sdpMid, sdpMLineIndex };
      const current = pc;
      if (!current || !remoteSet) {
        pending.push(ice);
        return;
      }
      await current.addIceCandidate(ice);
    },
  };
}
