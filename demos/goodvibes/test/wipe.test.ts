import { expect, test } from "bun:test";

test("an empty room alarm and the last leave both wipe Durable Object storage", async () => {
  const room = await Bun.file(new URL("../src/worker/room.ts", import.meta.url)).text();
  expect(room).toContain("wipeIfEmpty");
  expect(room).toContain("await this.ctx.storage.deleteAlarm()");
  expect(room).toContain("await this.ctx.storage.deleteAll()");
  const alarmIdx = room.indexOf("async alarm()");
  const dropIdx = room.indexOf("private async drop(");
  expect(alarmIdx).toBeGreaterThan(0);
  expect(dropIdx).toBeGreaterThan(0);
  expect(room.slice(alarmIdx, alarmIdx + 200)).toContain("wipeIfEmpty");
  expect(room.slice(dropIdx, dropIdx + 1600)).toContain("wipeIfEmpty");
});
