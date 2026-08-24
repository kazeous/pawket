import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

const ALGORITHM = "A256GCM";
const NODE_CIPHER = "aes-256-gcm";
const ENVELOPE_VERSION = 1;
const KEY_LENGTH_BYTES = 32;
const NONCE_LENGTH_BYTES = 12;
const TAG_LENGTH_BYTES = 16;
const MAX_PLAINTEXT_BYTES = 16_384;
const MAX_KEY_COUNT = 8;
const keyIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const bindingNamePattern = /^[a-z][a-z0-9_]{0,63}$/;
const recordIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
declare const keyringBrand: unique symbol;

export type SensitiveFieldBinding<
  RecordType extends string = string,
  FieldName extends string = string,
> = Readonly<{
  recordType: RecordType;
  recordId: string;
  fieldName: FieldName;
}>;

export type EncryptionEnvelope<
  RecordType extends string = string,
  FieldName extends string = string,
> = Readonly<{
  version: 1;
  algorithm: "A256GCM";
  keyId: string;
  nonce: string;
  ciphertext: string;
  authenticationTag: string;
  readonly __recordType?: RecordType;
  readonly __fieldName?: FieldName;
}>;

export type EncryptionKeyring = Readonly<{
  activeKeyId: string;
  [keyringBrand]: true;
}>;

const keyringMaterials = new WeakMap<EncryptionKeyring, ReadonlyMap<string, Uint8Array>>();

export class SensitiveDataCryptographyError extends Error {
  constructor() {
    super("Sensitive data cryptography operation failed");
    this.name = "SensitiveDataCryptographyError";
  }
}

function fail(): never {
  throw new SensitiveDataCryptographyError();
}

function validateBinding(binding: SensitiveFieldBinding): void {
  if (
    !bindingNamePattern.test(binding.recordType) ||
    !recordIdPattern.test(binding.recordId) ||
    !bindingNamePattern.test(binding.fieldName)
  ) {
    fail();
  }
}

function fieldAad(binding: SensitiveFieldBinding): Buffer {
  validateBinding(binding);
  return Buffer.from(
    JSON.stringify([
      "pawket-field",
      ENVELOPE_VERSION,
      binding.recordType,
      binding.recordId,
      binding.fieldName,
    ]),
    "utf8",
  );
}

function decodeEnvelopePart(
  value: string,
  options: { expectedLength?: number; maximumLength?: number } = {},
): Buffer {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) fail();
  const decoded = Buffer.from(value, "base64url");
  if (options.expectedLength !== undefined && decoded.length !== options.expectedLength) fail();
  if (options.maximumLength !== undefined && decoded.length > options.maximumLength) fail();
  return decoded;
}

function keyFor(keyring: EncryptionKeyring, keyId: string): Buffer {
  const key = keyringMaterials.get(keyring)?.get(keyId);
  if (!key || key.byteLength !== KEY_LENGTH_BYTES) fail();
  return Buffer.from(key);
}

export function createEncryptionKeyring(input: {
  activeKeyId: string;
  keys: Readonly<Record<string, Uint8Array>>;
}): EncryptionKeyring {
  try {
    if (!keyIdPattern.test(input.activeKeyId)) fail();
    const keys = new Map<string, Uint8Array>();
    for (const [keyId, key] of Object.entries(input.keys)) {
      if (!keyIdPattern.test(keyId) || key.byteLength !== KEY_LENGTH_BYTES) fail();
      keys.set(keyId, Uint8Array.from(key));
    }
    if (keys.size === 0 || keys.size > MAX_KEY_COUNT || !keys.has(input.activeKeyId)) fail();
    const keyring = Object.freeze({ activeKeyId: input.activeKeyId }) as EncryptionKeyring;
    keyringMaterials.set(keyring, keys);
    return keyring;
  } catch (error) {
    if (error instanceof SensitiveDataCryptographyError) throw error;
    return fail();
  }
}

export function encryptSensitiveField<
  RecordType extends string,
  FieldName extends string,
>(input: {
  plaintext: string;
  binding: SensitiveFieldBinding<RecordType, FieldName>;
  keyring: EncryptionKeyring;
}): EncryptionEnvelope<RecordType, FieldName> {
  try {
    if (
      input.plaintext.length === 0 ||
      Buffer.byteLength(input.plaintext, "utf8") > MAX_PLAINTEXT_BYTES
    ) {
      fail();
    }
    const nonce = randomBytes(NONCE_LENGTH_BYTES);
    const cipher = createCipheriv(NODE_CIPHER, keyFor(input.keyring, input.keyring.activeKeyId), nonce, {
      authTagLength: TAG_LENGTH_BYTES,
    });
    cipher.setAAD(fieldAad(input.binding));
    const ciphertext = Buffer.concat([
      cipher.update(input.plaintext, "utf8"),
      cipher.final(),
    ]);
    return {
      version: ENVELOPE_VERSION,
      algorithm: ALGORITHM,
      keyId: input.keyring.activeKeyId,
      nonce: nonce.toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
      authenticationTag: cipher.getAuthTag().toString("base64url"),
    };
  } catch (error) {
    if (error instanceof SensitiveDataCryptographyError) throw error;
    return fail();
  }
}

export function decryptSensitiveField<
  RecordType extends string,
  FieldName extends string,
>(input: {
  envelope: EncryptionEnvelope<RecordType, FieldName>;
  binding: SensitiveFieldBinding<RecordType, FieldName>;
  keyring: EncryptionKeyring;
}): string {
  try {
    if (
      input.envelope.version !== ENVELOPE_VERSION ||
      input.envelope.algorithm !== ALGORITHM ||
      !keyIdPattern.test(input.envelope.keyId)
    ) {
      fail();
    }
    const decipher = createDecipheriv(
      NODE_CIPHER,
      keyFor(input.keyring, input.envelope.keyId),
      decodeEnvelopePart(input.envelope.nonce, { expectedLength: NONCE_LENGTH_BYTES }),
      { authTagLength: TAG_LENGTH_BYTES },
    );
    decipher.setAAD(fieldAad(input.binding));
    decipher.setAuthTag(
      decodeEnvelopePart(input.envelope.authenticationTag, { expectedLength: TAG_LENGTH_BYTES }),
    );
    return Buffer.concat([
      decipher.update(
        decodeEnvelopePart(input.envelope.ciphertext, { maximumLength: MAX_PLAINTEXT_BYTES }),
      ),
      decipher.final(),
    ]).toString("utf8");
  } catch (error) {
    if (error instanceof SensitiveDataCryptographyError) throw error;
    return fail();
  }
}
