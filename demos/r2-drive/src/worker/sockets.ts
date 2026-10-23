/** Live-log sockets are read-only and die with the drive. */

export const MAX_SOCKETS_PER_DRIVE = 4;

export function socketLimitResponse(open: number): Response | null {
  if (open >= MAX_SOCKETS_PER_DRIVE) return new Response("Too many live connections", { status: 429 });
  return null;
}

export function rejectClientMessage(socket: { close(code: number, reason?: string): void }): void {
  socket.close(1008, "read-only");
}

export function closeClientSocket(socket: { close(code: number, reason?: string): void }, code: number, reason: string): void {
  try {
    socket.close(code, reason);
  } catch {
    // Already closed.
  }
}

export function closeLiveSockets(sockets: { close(code: number, reason?: string): void }[]): void {
  for (const socket of sockets) {
    try {
      socket.close(1000, "wiped");
    } catch {
      // Already closed.
    }
  }
}
