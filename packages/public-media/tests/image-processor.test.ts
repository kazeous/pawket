import { Buffer } from "node:buffer";

import sharp from "sharp";
import { beforeAll, describe, expect, test } from "vitest";

import { DERIVATIVE_MAX_BYTES } from "../src/media-policy.js";
import {
  PublicImageProcessingError,
  processPublicImage,
} from "../src/image-processor.js";

type FixtureName =
  | "alphaPng"
  | "animatedGif"
  | "arbitrary"
  | "extremeDimensions"
  | "jpeg"
  | "jpegPolyglot"
  | "metadataJpeg"
  | "mp4"
  | "png"
  | "staticGif"
  | "svg"
  | "truncated"
  | "webp";

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

function withPngDimensions(source: Uint8Array, width: number, height: number): Uint8Array {
  const output = Buffer.from(source);
  output.writeUInt32BE(width, 16);
  output.writeUInt32BE(height, 20);
  output.writeUInt32BE(crc32(output.subarray(12, 29)), 29);
  return output;
}

async function createSyntheticMediaFixtures(): Promise<Record<FixtureName, Uint8Array>> {
  const base = sharp({
    create: {
      width: 32,
      height: 24,
      channels: 3,
      background: { r: 20, g: 90, b: 180 },
    },
  });
  const jpeg = await base.clone().jpeg({ quality: 90 }).toBuffer();
  const png = await base.clone().png().toBuffer();
  const webp = await base.clone().webp({ quality: 90 }).toBuffer();
  const metadataJpeg = await base
    .clone()
    .withMetadata({ orientation: 6 })
    .withExifMerge({
      IFD0: { ImageDescription: "synthetic private text" },
      IFD3: {
        GPSLatitudeRef: "N",
        GPSLatitude: "10/1 45/1 0/1",
        GPSLongitudeRef: "E",
        GPSLongitude: "106/1 40/1 0/1",
      },
    })
    .jpeg({ quality: 90 })
    .toBuffer();
  const alphaPng = await sharp({
    create: {
      width: 20,
      height: 12,
      channels: 4,
      background: { r: 200, g: 20, b: 90, alpha: 0.45 },
    },
  })
    .png()
    .toBuffer();

  return {
    alphaPng,
    animatedGif: Buffer.from("47494638396101000100800000000000ffffff21ff0b4e45545343415045322e3003010000002c00000000010001000002024401002c00000000010001000002024401003b", "hex"),
    arbitrary: Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0x01]),
    extremeDimensions: withPngDimensions(png, 40_000_001, 1),
    jpeg,
    jpegPolyglot: Buffer.concat([jpeg, Buffer.from("<script>polyglot</script>", "utf8")]),
    metadataJpeg,
    mp4: Buffer.from("000000186674797069736f6d0000020069736f6d", "hex"),
    png,
    staticGif: Buffer.from("47494638396101000100800000000000ffffff2c00000000010001000002024401003b", "hex"),
    svg: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>', "utf8"),
    truncated: png.subarray(0, png.length - 8),
    webp,
  };
}

describe("deterministic public image processor", () => {
  let fixtures: Record<FixtureName, Uint8Array>;

  beforeAll(async () => {
    fixtures = await createSyntheticMediaFixtures();
  });

  test("the complete security matrix is generated in memory", () => {
    expect(Object.keys(fixtures).sort()).toEqual([
      "alphaPng",
      "animatedGif",
      "arbitrary",
      "extremeDimensions",
      "jpeg",
      "jpegPolyglot",
      "metadataJpeg",
      "mp4",
      "png",
      "staticGif",
      "svg",
      "truncated",
      "webp",
    ]);
  });

  test.each(["jpeg", "png", "webp"] as const)(
    "normalizes %s to four deterministic WebP outputs",
    async (name) => {
      const first = await processPublicImage(fixtures[name]);
      const second = await processPublicImage(fixtures[name]);

      expect(first.outputs.map((output) => output.variant)).toEqual([
        "master",
        "thumb",
        "display",
        "large",
      ]);
      expect(first.outputs.map((output) => output.sha256)).toEqual(
        second.outputs.map((output) => output.sha256),
      );
      expect(first.outputs.map((output) => Buffer.from(output.bytes).toString("base64"))).toEqual(
        second.outputs.map((output) => Buffer.from(output.bytes).toString("base64")),
      );
      expect(first.outputs.every((output) => output.format === "webp")).toBe(true);
      for (const output of first.outputs) {
        expect(output.byteSize).toBe(output.bytes.byteLength);
        expect(output.byteSize).toBeLessThanOrEqual(DERIVATIVE_MAX_BYTES[output.variant]);
      }
    },
  );

  test.each([
    ["animatedGif", "unsupported_format"],
    ["staticGif", "unsupported_format"],
    ["svg", "unsupported_format"],
    ["mp4", "unsupported_format"],
    ["arbitrary", "unsupported_format"],
    ["truncated", "malformed_image"],
    ["jpegPolyglot", "malformed_image"],
    ["extremeDimensions", "dimensions_exceeded"],
  ] as const)("rejects %s before readiness", async (name, code) => {
    await expect(processPublicImage(fixtures[name])).rejects.toEqual(
      expect.objectContaining<Partial<PublicImageProcessingError>>({ code }),
    );
  });

  test("applies orientation and strips private metadata from every derivative", async () => {
    const sourceMetadata = await sharp(fixtures.metadataJpeg).metadata();
    expect(sourceMetadata.orientation).toBe(6);
    expect(sourceMetadata.exif).toBeDefined();
    expect(Buffer.from(sourceMetadata.exif!).includes(Buffer.from("synthetic private text"))).toBe(
      true,
    );

    const processed = await processPublicImage(fixtures.metadataJpeg);
    expect(processed.source).toMatchObject({ width: 24, height: 32, format: "jpeg" });
    for (const output of processed.outputs) {
      const metadata = await sharp(output.bytes).metadata();
      expect(metadata).toMatchObject({ format: "webp", width: 24, height: 32, space: "srgb" });
      expect(metadata.orientation).toBeUndefined();
      expect(metadata.exif).toBeUndefined();
      expect(metadata.icc).toBeUndefined();
      expect(metadata.iptc).toBeUndefined();
      expect(metadata.xmp).toBeUndefined();
    }
  });

  test("preserves alpha without enlarging the source", async () => {
    const processed = await processPublicImage(fixtures.alphaPng);
    for (const output of processed.outputs) {
      const metadata = await sharp(output.bytes).metadata();
      expect(metadata.hasAlpha).toBe(true);
      expect(metadata.width).toBe(20);
      expect(metadata.height).toBe(12);
    }
  });
});
