/** Test fixtures. The office allow-path parses ZIP; it does not build one. */

export function zipStored(files: { name: string; data: Uint8Array }[]): Uint8Array {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const file of files) {
    const name = new TextEncoder().encode(file.name);
    const local = new Uint8Array(30 + name.byteLength + file.data.byteLength);
    writeU32(local, 0, 0x04034b50);
    writeU16(local, 8, 0);
    writeU32(local, 18, file.data.byteLength);
    writeU32(local, 22, file.data.byteLength);
    writeU16(local, 26, name.byteLength);
    local.set(name, 30);
    local.set(file.data, 30 + name.byteLength);
    locals.push(local);
    const central = new Uint8Array(46 + name.byteLength);
    writeU32(central, 0, 0x02014b50);
    writeU16(central, 10, 0);
    writeU32(central, 20, file.data.byteLength);
    writeU32(central, 24, file.data.byteLength);
    writeU16(central, 28, name.byteLength);
    writeU32(central, 42, offset);
    central.set(name, 46);
    centrals.push(central);
    offset += local.byteLength;
  }
  return finish(files.length, offset, locals, centrals);
}

export async function zipDeflated(files: { name: string; data: Uint8Array }[]): Promise<Uint8Array> {
  const packed = await Promise.all(
    files.map(async (file) => ({ name: file.name, data: file.data, compressed: await deflateRaw(file.data), crc: crc32(file.data) })),
  );
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const file of packed) {
    const name = new TextEncoder().encode(file.name);
    const local = new Uint8Array(30 + name.byteLength + file.compressed.byteLength);
    writeU32(local, 0, 0x04034b50);
    writeU16(local, 8, 8);
    writeU32(local, 14, file.crc);
    writeU32(local, 18, file.compressed.byteLength);
    writeU32(local, 22, file.data.byteLength);
    writeU16(local, 26, name.byteLength);
    local.set(name, 30);
    local.set(file.compressed, 30 + name.byteLength);
    locals.push(local);
    const central = new Uint8Array(46 + name.byteLength);
    writeU32(central, 0, 0x02014b50);
    writeU16(central, 10, 8);
    writeU32(central, 16, file.crc);
    writeU32(central, 20, file.compressed.byteLength);
    writeU32(central, 24, file.data.byteLength);
    writeU16(central, 28, name.byteLength);
    writeU32(central, 42, offset);
    central.set(name, 46);
    centrals.push(central);
    offset += local.byteLength;
  }
  return finish(files.length, offset, locals, centrals);
}

function finish(count: number, offset: number, locals: Uint8Array[], centrals: Uint8Array[]): Uint8Array {
  const centralStart = offset;
  const centralSize = centrals.reduce((sum, part) => sum + part.byteLength, 0);
  const end = new Uint8Array(22);
  writeU32(end, 0, 0x06054b50);
  writeU16(end, 8, count);
  writeU16(end, 10, count);
  writeU32(end, 12, centralSize);
  writeU32(end, 16, centralStart);
  const total = offset + centralSize + end.byteLength;
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const part of [...locals, ...centrals, end]) {
    out.set(part, cursor);
    cursor += part.byteLength;
  }
  return out;
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function writeU16(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >> 8) & 0xff;
}

function writeU32(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >> 8) & 0xff;
  bytes[offset + 2] = (value >> 16) & 0xff;
  bytes[offset + 3] = (value >> 24) & 0xff;
}
