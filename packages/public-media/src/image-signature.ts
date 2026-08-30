import { MAX_SOURCE_PIXELS, type SourceFormat } from "./media-policy.js";

export type ApprovedImageSignature = Readonly<{
  format: SourceFormat;
  width: number;
  height: number;
}>;

export type ImageSignatureErrorCode =
  | "unsupported_format"
  | "malformed_image"
  | "dimensions_exceeded";

export class ImageSignatureError extends Error {
  constructor(readonly code: ImageSignatureErrorCode) {
    super(code);
    this.name = "ImageSignatureError";
  }
}

function fail(code: ImageSignatureErrorCode): never {
  throw new ImageSignatureError(code);
}

function dimensions(format: SourceFormat, width: number, height: number): ApprovedImageSignature {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    fail("malformed_image");
  }
  if (width * height > MAX_SOURCE_PIXELS) fail("dimensions_exceeded");
  return { format, width, height };
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function inspectPng(bytes: Uint8Array): ApprovedImageSignature {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  let width = 0;
  let height = 0;
  let sawHeader = false;
  let sawImageData = false;
  let sawEnd = false;
  while (offset < bytes.byteLength) {
    if (bytes.byteLength - offset < 12) fail("malformed_image");
    const length = view.getUint32(offset, false);
    const chunkEnd = offset + 12 + length;
    if (!Number.isSafeInteger(chunkEnd) || chunkEnd > bytes.byteLength) fail("malformed_image");
    const typeBytes = bytes.subarray(offset + 4, offset + 8);
    const type = String.fromCharCode(...typeBytes);
    const expectedCrc = view.getUint32(offset + 8 + length, false);
    if (crc32(bytes.subarray(offset + 4, offset + 8 + length)) !== expectedCrc) {
      fail("malformed_image");
    }
    if (!sawHeader && type !== "IHDR") fail("malformed_image");
    if (type === "IHDR") {
      if (sawHeader || length !== 13) fail("malformed_image");
      width = view.getUint32(offset + 8, false);
      height = view.getUint32(offset + 12, false);
      dimensions("png", width, height);
      sawHeader = true;
    } else if (type === "IDAT") {
      if (!sawHeader || sawEnd) fail("malformed_image");
      sawImageData = true;
    } else if (type === "IEND") {
      if (length !== 0 || !sawImageData || sawEnd || chunkEnd !== bytes.byteLength) {
        fail("malformed_image");
      }
      sawEnd = true;
    } else if (type === "acTL" || type === "fcTL" || type === "fdAT") {
      fail("unsupported_format");
    } else if ((typeBytes[0]! & 0x20) === 0 && !["PLTE"].includes(type)) {
      fail("malformed_image");
    }
    offset = chunkEnd;
  }
  if (!sawHeader || !sawImageData || !sawEnd) fail("malformed_image");
  return dimensions("png", width, height);
}

const JPEG_START_OF_FRAME = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

function inspectJpeg(bytes: Uint8Array): ApprovedImageSignature {
  let offset = 2;
  let width = 0;
  let height = 0;
  let sawFrame = false;
  let sawScan = false;
  while (offset < bytes.byteLength) {
    if (bytes[offset] !== 0xff) fail("malformed_image");
    while (bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.byteLength) fail("malformed_image");
    const marker = bytes[offset]!;
    offset += 1;
    if (marker === 0x00) fail("malformed_image");
    if (marker === 0xd9) {
      if (!sawFrame || !sawScan || offset !== bytes.byteLength) fail("malformed_image");
      return dimensions("jpeg", width, height);
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      continue;
    }
    if (offset + 2 > bytes.byteLength) fail("malformed_image");
    const length = (bytes[offset]! << 8) | bytes[offset + 1]!;
    if (length < 2 || offset + length > bytes.byteLength) fail("malformed_image");
    if (JPEG_START_OF_FRAME.has(marker)) {
      if (length < 8 || sawFrame) fail("malformed_image");
      height = (bytes[offset + 3]! << 8) | bytes[offset + 4]!;
      width = (bytes[offset + 5]! << 8) | bytes[offset + 6]!;
      dimensions("jpeg", width, height);
      sawFrame = true;
    }
    offset += length;
    if (marker === 0xda) {
      if (!sawFrame) fail("malformed_image");
      sawScan = true;
      let foundMarker = false;
      while (offset < bytes.byteLength) {
        if (bytes[offset] !== 0xff) {
          offset += 1;
          continue;
        }
        const markerOffset = offset;
        while (bytes[offset] === 0xff) offset += 1;
        if (offset >= bytes.byteLength) fail("malformed_image");
        const scanMarker = bytes[offset]!;
        if (scanMarker === 0x00 || (scanMarker >= 0xd0 && scanMarker <= 0xd7)) {
          offset += 1;
          continue;
        }
        offset = markerOffset;
        foundMarker = true;
        break;
      }
      if (!foundMarker) fail("malformed_image");
    }
  }
  fail("malformed_image");
}

function uint24le(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16);
}

function inspectWebp(bytes: Uint8Array): ApprovedImageSignature {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 20 || view.getUint32(4, true) + 8 !== bytes.byteLength) {
    fail("malformed_image");
  }
  let offset = 12;
  let width = 0;
  let height = 0;
  let canvasWidth = 0;
  let canvasHeight = 0;
  let imageChunks = 0;
  while (offset < bytes.byteLength) {
    if (bytes.byteLength - offset < 8) fail("malformed_image");
    const type = String.fromCharCode(...bytes.subarray(offset, offset + 4));
    const length = view.getUint32(offset + 4, true);
    const dataOffset = offset + 8;
    const chunkEnd = dataOffset + length;
    const paddedEnd = chunkEnd + (length & 1);
    if (!Number.isSafeInteger(paddedEnd) || paddedEnd > bytes.byteLength) fail("malformed_image");
    if (type === "ANIM" || type === "ANMF") fail("unsupported_format");
    if (type === "VP8X") {
      if (length !== 10 || canvasWidth !== 0 || (bytes[dataOffset]! & 0x02) !== 0) {
        fail((bytes[dataOffset]! & 0x02) !== 0 ? "unsupported_format" : "malformed_image");
      }
      canvasWidth = uint24le(bytes, dataOffset + 4) + 1;
      canvasHeight = uint24le(bytes, dataOffset + 7) + 1;
      dimensions("webp", canvasWidth, canvasHeight);
    } else if (type === "VP8 ") {
      if (
        length < 10 ||
        bytes[dataOffset + 3] !== 0x9d ||
        bytes[dataOffset + 4] !== 0x01 ||
        bytes[dataOffset + 5] !== 0x2a
      ) fail("malformed_image");
      imageChunks += 1;
      width = (bytes[dataOffset + 6]! | (bytes[dataOffset + 7]! << 8)) & 0x3fff;
      height = (bytes[dataOffset + 8]! | (bytes[dataOffset + 9]! << 8)) & 0x3fff;
      dimensions("webp", width, height);
    } else if (type === "VP8L") {
      if (length < 5 || bytes[dataOffset] !== 0x2f) fail("malformed_image");
      imageChunks += 1;
      const bits = view.getUint32(dataOffset + 1, true);
      width = (bits & 0x3fff) + 1;
      height = ((bits >>> 14) & 0x3fff) + 1;
      dimensions("webp", width, height);
    }
    offset = paddedEnd;
  }
  if (offset !== bytes.byteLength || imageChunks !== 1) fail("malformed_image");
  if (canvasWidth !== 0 && (canvasWidth !== width || canvasHeight !== height)) {
    fail("malformed_image");
  }
  return dimensions("webp", width, height);
}

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  return signature.every((byte, index) => bytes[index] === byte);
}

export function inspectApprovedImageSignature(value: unknown): ApprovedImageSignature {
  if (!(value instanceof Uint8Array) || value.byteLength < 4) fail("unsupported_format");
  const bytes = Uint8Array.from(value);
  if (startsWith(bytes, [0xff, 0xd8])) return inspectJpeg(bytes);
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return inspectPng(bytes);
  }
  if (
    bytes.byteLength >= 12 &&
    String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP"
  ) return inspectWebp(bytes);
  fail("unsupported_format");
}
