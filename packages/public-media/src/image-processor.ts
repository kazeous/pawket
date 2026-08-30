import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { types as nodeTypes } from "node:util";

import sharp from "sharp";

import {
  DERIVATIVE_MAX_BYTES,
  MAX_SOURCE_BYTES,
  MAX_SOURCE_PIXELS,
  type MediaVariant,
  type SourceFormat,
} from "./media-policy.js";
import {
  ImageSignatureError,
  inspectApprovedImageSignature,
  type ImageSignatureErrorCode,
} from "./image-signature.js";

export type PublicImageProcessingErrorCode =
  | ImageSignatureErrorCode
  | "output_too_large"
  | "failed_validation";

export class PublicImageProcessingError extends Error {
  constructor(readonly code: PublicImageProcessingErrorCode) {
    super(code);
    this.name = "PublicImageProcessingError";
  }
}

export type PublicImageOutput = Readonly<{
  variant: MediaVariant;
  format: "webp";
  width: number;
  height: number;
  byteSize: number;
  sha256: string;
  bytes: Uint8Array;
}>;

export type ProcessedPublicImage = Readonly<{
  source: Readonly<{ format: SourceFormat; width: number; height: number }>;
  outputs: readonly PublicImageOutput[];
}>;

const VARIANT_PROFILE = [
  { variant: "master", width: 4096, height: 4096, quality: 88 },
  { variant: "thumb", width: 384, height: 384, quality: 78 },
  { variant: "display", width: 1280, height: 1280, quality: 82 },
  { variant: "large", width: 2400, height: 2400, quality: 84 },
] as const satisfies readonly Readonly<{
  variant: MediaVariant;
  width: number;
  height: number;
  quality: number;
}>[];

function fail(code: PublicImageProcessingErrorCode): never {
  throw new PublicImageProcessingError(code);
}

function contentHash(bytes: Uint8Array): string {
  return `sha256:v1:${createHash("sha256").update(bytes).digest("base64url")}`;
}

const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype) as object;
const BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  "byteLength",
)?.get;
const BUFFER_GETTER = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, "buffer")?.get;

function snapshotPublicImageBytes(value: unknown): Uint8Array {
  try {
    if (
      typeof value !== "object" ||
      value === null ||
      nodeTypes.isProxy(value) ||
      !BYTE_LENGTH_GETTER ||
      !BUFFER_GETTER
    ) {
      fail("failed_validation");
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Uint8Array.prototype && prototype !== Buffer.prototype) {
      fail("failed_validation");
    }
    const byteLength = Reflect.apply(BYTE_LENGTH_GETTER, value, []) as unknown;
    const backingBuffer = Reflect.apply(BUFFER_GETTER, value, []) as unknown;
    if (
      !Number.isSafeInteger(byteLength) ||
      (byteLength as number) < 1 ||
      (byteLength as number) > MAX_SOURCE_BYTES ||
      (typeof SharedArrayBuffer !== "undefined" && backingBuffer instanceof SharedArrayBuffer)
    ) {
      fail("failed_validation");
    }
    const snapshot = new Uint8Array(byteLength as number);
    Uint8Array.prototype.set.call(snapshot, value as Uint8Array);
    return snapshot;
  } catch (error) {
    if (error instanceof PublicImageProcessingError) throw error;
    fail("failed_validation");
  }
}

export async function processPublicImage(value: unknown): Promise<ProcessedPublicImage> {
  const sourceBytes = snapshotPublicImageBytes(value);
  let signature: ReturnType<typeof inspectApprovedImageSignature>;
  try {
    signature = inspectApprovedImageSignature(sourceBytes);
  } catch (error) {
    if (error instanceof ImageSignatureError) fail(error.code);
    fail("failed_validation");
  }

  try {
    const pipeline = sharp(sourceBytes, {
      animated: false,
      failOn: "error",
      limitInputPixels: MAX_SOURCE_PIXELS,
      sequentialRead: true,
    })
      .rotate()
      .toColourspace("srgb");
    const outputs: PublicImageOutput[] = [];
    for (const profile of VARIANT_PROFILE) {
      const encoded = await pipeline
        .clone()
        .resize({
          width: profile.width,
          height: profile.height,
          fit: "inside",
          withoutEnlargement: true,
        })
        .webp({
          quality: profile.quality,
          alphaQuality: 90,
          effort: 4,
          smartSubsample: true,
        })
        .toBuffer({ resolveWithObject: true });
      if (
        !Number.isSafeInteger(encoded.info.width) ||
        !Number.isSafeInteger(encoded.info.height) ||
        encoded.info.width < 1 ||
        encoded.info.height < 1 ||
        encoded.info.width > profile.width ||
        encoded.info.height > profile.height ||
        encoded.data.byteLength < 1 ||
        encoded.data.byteLength > DERIVATIVE_MAX_BYTES[profile.variant]
      ) {
        fail("output_too_large");
      }
      const bytes = Uint8Array.from(encoded.data);
      outputs.push({
        variant: profile.variant,
        format: "webp",
        width: encoded.info.width,
        height: encoded.info.height,
        byteSize: bytes.byteLength,
        sha256: contentHash(bytes),
        bytes,
      });
    }
    const master = outputs[0];
    if (!master || master.variant !== "master") fail("failed_validation");
    return {
      source: { format: signature.format, width: master.width, height: master.height },
      outputs,
    };
  } catch (error) {
    if (error instanceof PublicImageProcessingError) throw error;
    fail("malformed_image");
  }
}
