function createBytes(minimumLength: number, byteLength?: number): Uint8Array {
  const resolvedLength = byteLength ?? minimumLength;
  if (resolvedLength < minimumLength) {
    throw new RangeError(`byteLength must be at least ${minimumLength}.`);
  }
  return new Uint8Array(resolvedLength);
}

function writeAscii(bytes: Uint8Array, offset: number, value: string): void {
  for (const [index, character] of [...value].entries()) {
    bytes[offset + index] = character.charCodeAt(0);
  }
}

function writeUint24LittleEndian(
  bytes: Uint8Array,
  offset: number,
  value: number,
): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >> 8) & 0xff;
  bytes[offset + 2] = (value >> 16) & 0xff;
}

export function createPngHeader(
  width: number,
  height: number,
  byteLength?: number,
): Uint8Array {
  const bytes = createBytes(24, byteLength);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setUint32(8, 13);
  writeAscii(bytes, 12, "IHDR");
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

export function createJpegHeader(width: number, height: number): Uint8Array {
  const bytes = createBytes(11);
  bytes.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x07, 0x08]);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setUint16(7, height);
  view.setUint16(9, width);
  return bytes;
}

export function createGifHeader(width: number, height: number): Uint8Array {
  const bytes = createBytes(10);
  writeAscii(bytes, 0, "GIF89a");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setUint16(6, width, true);
  view.setUint16(8, height, true);
  return bytes;
}

export function createWebpHeader(width: number, height: number): Uint8Array {
  const bytes = createBytes(30);
  writeAscii(bytes, 0, "RIFF");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setUint32(4, bytes.byteLength - 8, true);
  writeAscii(bytes, 8, "WEBP");
  writeAscii(bytes, 12, "VP8X");
  view.setUint32(16, 10, true);
  writeUint24LittleEndian(bytes, 24, width - 1);
  writeUint24LittleEndian(bytes, 27, height - 1);
  return bytes;
}
