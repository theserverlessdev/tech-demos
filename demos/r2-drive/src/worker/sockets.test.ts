import { expect, test } from "bun:test";
import { closeLiveSockets, rejectClientMessage, socketLimitResponse } from "./sockets";

test("a fifth socket is refused, a client message closes, and a wipe closes the rest", () => {
  expect(socketLimitResponse(3)).toBeNull();
  const refused = socketLimitResponse(4);
  expect(refused?.status).toBe(429);
  const sender = fake();
  rejectClientMessage(sender);
  expect(sender.code).toBe(1008);
  expect(sender.reason).toBe("read-only");
  const open = [fake(), fake(), fake()];
  closeLiveSockets(open);
  expect(open.map((socket) => socket.code)).toEqual([1000, 1000, 1000]);
});

function fake() {
  return {
    code: 0,
    reason: "",
    close(code: number, reason?: string) {
      this.code = code;
      this.reason = reason ?? "";
    },
  };
}
