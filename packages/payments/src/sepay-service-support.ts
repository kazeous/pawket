import { createLookupHmac, decryptSensitiveField, encryptSensitiveField, type EncryptionEnvelope, type EncryptionKeyring } from "@pawket/security";
import type { PawketTransaction } from "@pawket/database";

export type SePayActor = Readonly<{ userId: string; sessionId: string }>;
export type SePayAssurance = Readonly<{ primaryAuthenticatedAt: Date; totpEnrolled: boolean; totpVerifiedAt: Date | null; sessionExpiresAt: Date }>;
export type SePayAssurancePort = { getTipSessionAssurance(tx: PawketTransaction, actor: SePayActor, at: Date): Promise<SePayAssurance | null> };
export type SePayServiceErrorCode = "invalid_request" | "not_available" | "payments_disabled" | "provider_unavailable" | "not_authorized" |
  "recent_auth_required" | "totp_required" | "version_conflict" | "idempotency_conflict" | "open_manual_intents" |
  "account_conflict" | "reconnect_required" | "evidence_mismatch" | "intent_not_pending" | "rate_limited" | "dependency_unavailable";
export class SePayServiceError extends Error {
  constructor(readonly code: SePayServiceErrorCode, readonly retryAfterSeconds?: number) { super(code); this.name = "SePayServiceError"; }
}
export function sepayFail(code: SePayServiceErrorCode, retryAfterSeconds?: number): never { throw new SePayServiceError(code, retryAfterSeconds); }
export const sepayUuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value);
export const sepayIdentifier = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(value);
export const sepayValidDate = (value: unknown): value is Date => value instanceof Date && Number.isFinite(value.getTime());
export function validateSePayActor(actor: SePayActor): void {
  if (!actor || !sepayIdentifier(actor.userId) || !sepayIdentifier(actor.sessionId)) sepayFail("not_authorized");
}
export function validateSePayCommand(command: { actor: SePayActor; idempotencyKey: string; requestId: string }): void {
  validateSePayActor(command.actor);
  if (!sepayIdentifier(command.requestId) || typeof command.idempotencyKey !== "string" || !/^[A-Za-z0-9._-]{8,200}$/u.test(command.idempotencyKey)) sepayFail("invalid_request");
}
export function requireSePayAssurance(proof: SePayAssurance | null, at: Date, fresh: boolean): SePayAssurance {
  if (!proof || !sepayValidDate(at) || !sepayValidDate(proof.primaryAuthenticatedAt) || !sepayValidDate(proof.sessionExpiresAt) ||
    typeof proof.totpEnrolled !== "boolean" || (proof.totpVerifiedAt !== null && !sepayValidDate(proof.totpVerifiedAt)) || proof.sessionExpiresAt <= at) sepayFail("not_authorized");
  const age = at.getTime() - proof.primaryAuthenticatedAt.getTime();
  if (age < 0 || (fresh && age > 900_000)) sepayFail("recent_auth_required");
  if (fresh && proof.totpEnrolled && (!proof.totpVerifiedAt || proof.totpVerifiedAt > at || proof.totpVerifiedAt < proof.primaryAuthenticatedAt || at.getTime() - proof.totpVerifiedAt.getTime() > 300_000)) sepayFail("totp_required");
  return proof;
}
export function createSePayCryptography(input: { keyring: EncryptionKeyring; lookupHmacKey: Uint8Array }) {
  const key = new Uint8Array(input.lookupHmacKey);
  return {
    hash: (context: string, value: string) => createLookupHmac({ key, context: `sepay-${context}`, value }),
    encrypt: (recordType: string, recordId: string, fieldName: string, plaintext: string) =>
      encryptSensitiveField({ keyring: input.keyring, binding: { recordType, recordId, fieldName }, plaintext }),
    decrypt: (recordType: string, recordId: string, fieldName: string, envelope: EncryptionEnvelope) =>
      decryptSensitiveField({ keyring: input.keyring, binding: { recordType, recordId, fieldName }, envelope }),
  };
}
export async function sepayBoundary<T>(run: () => Promise<T>): Promise<T> {
  try { return await run(); } catch (error) {
    if (error instanceof SePayServiceError) throw error;
    return sepayFail("dependency_unavailable");
  }
}
