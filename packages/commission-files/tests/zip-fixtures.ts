import { crc32 } from "node:zlib";

/** Builds an uncompressed ("stored") ZIP. `encrypted` sets the traditional-encryption flag bit for scanner tests only. */
export function storedZip(entries: ReadonlyArray<{ name: string; data: Uint8Array; encrypted?: boolean }>): Uint8Array {
  const locals: Buffer[] = []; const centrals: Buffer[] = []; let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8"); const flags = entry.encrypted ? 0x0001 : 0; const crc = crc32(entry.data);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(flags, 6);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(entry.data.byteLength, 18); local.writeUInt32LE(entry.data.byteLength, 22); local.writeUInt16LE(name.byteLength, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(flags, 8);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(entry.data.byteLength, 20); central.writeUInt32LE(entry.data.byteLength, 24); central.writeUInt16LE(name.byteLength, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, name, Buffer.from(entry.data)); centrals.push(central, name);
    offset += local.byteLength + name.byteLength + entry.data.byteLength;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.byteLength, 12); end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, directory, end]));
}
