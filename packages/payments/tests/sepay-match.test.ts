import { describe, expect, test } from "vitest";

import { matchSePayTip, type SePayTipMatchIntent } from "../src/sepay-match.js";
import type { SePayProviderBinding, SePayProviderCapabilities, SePayProviderTransaction } from "../src/sepay-provider.js";
import type { SePayWebhookEvent } from "../src/sepay-webhook.js";

const reference = "PW0123456789ABCDEF0123";
const now = new Date("2026-09-24T00:05:00Z");
const capabilities: SePayProviderCapabilities = { oauthApplication: true, pkceS256: true, stableAccountIdentity: true,
  canonicalTransactionIdentity: true, bankTimeReference: true, remoteRevocation: false };
const binding: SePayProviderBinding = { environment: "test", tenantId: "synthetic-tenant", accountId: "11", bankBin: "970436",
  bankGateway: "Vietcombank", accountNumber: "012345678901", subAccount: null };
const intent: SePayTipMatchIntent = { settlementLane: "provider_bound", state: "awaiting_transfer", amountVnd: 50_000,
  transferReference: reference, bankBin: binding.bankBin, accountNumber: binding.accountNumber,
  cutoverAt: new Date("2026-09-24T00:01:00Z"), createdAt: new Date("2026-09-24T00:02:00Z"), expiresAt: new Date("2026-09-25T00:02:00Z") };
const event: SePayWebhookEvent = { id: "123", bankGateway: binding.bankGateway, accountNumber: binding.accountNumber, subAccount: null,
  amountVnd: 50_000, occurredAt: new Date("2026-09-24T00:03:00Z"), reference, referenceStatus: "exact", bankReference: "SYNTHETIC-REFERENCE" };
const transaction: SePayProviderTransaction = { id: event.id, binding, amountVnd: event.amountVnd, direction: "in",
  occurredAt: event.occurredAt, reference, referenceStatus: "exact", bankReference: event.bankReference };
const evidence = () => ({ intent, binding, event, capabilities, now, readback: { kind: "complete" as const, transactions: [transaction] } });

describe("exact SePay evidence matching", () => {
  test("requires independent complete evidence agreeing on destination, identity, amount, reference and time", () => {
    expect(matchSePayTip(evidence())).toEqual({ kind: "matched", transaction });
  });

  test.each(["oauthApplication", "pkceS256", "stableAccountIdentity", "canonicalTransactionIdentity", "bankTimeReference"] as const)(
    "does not infer the unproved %s capability from a signed webhook", (capability) => {
      expect(matchSePayTip({ ...evidence(), capabilities: { ...capabilities, [capability]: false } })).toEqual({ kind: "review", reason: "contract_unverified" });
    },
  );

  test("never promotes historical manual attestations or terminal provider intents", () => {
    expect(matchSePayTip({ ...evidence(), intent: { ...intent, settlementLane: "manual_attested", cutoverAt: null } })).toEqual({ kind: "review", reason: "manual_lane" });
    for (const state of ["confirmed", "expired", "rejected"] as const) {
      expect(matchSePayTip({ ...evidence(), intent: { ...intent, state } })).toEqual({ kind: "review", reason: "intent_not_pending" });
    }
    expect(matchSePayTip({ ...evidence(), now: intent.expiresAt })).toEqual({ kind: "review", reason: "expired" });
  });

  test("requires complete readback and exactly one canonical transaction for the full reference", () => {
    expect(matchSePayTip({ ...evidence(), readback: { kind: "inconclusive", reason: "pagination_changed" } })).toEqual({ kind: "review", reason: "readback_inconclusive" });
    expect(matchSePayTip({ ...evidence(), readback: { kind: "complete", transactions: [] } })).toEqual({ kind: "review", reason: "not_found" });
    for (const duplicate of [transaction, { ...transaction, id: "124" }]) {
      expect(matchSePayTip({ ...evidence(), readback: { kind: "complete", transactions: [transaction, duplicate] } })).toEqual({ kind: "review", reason: "ambiguous" });
    }
    // Sharing a bank reference with an unrelated transfer does not consume its identity.
    expect(matchSePayTip({ ...evidence(), readback: { kind: "complete", transactions: [transaction, { ...transaction, id: "999", reference: "PWFFFFFFFFFFFFFFFFFFFF" }] } }).kind).toBe("matched");
  });

  test.each([
    { id: "124" }, { binding: { ...binding, environment: "live" as const } },
    { binding: { ...binding, tenantId: "different-tenant" } }, { binding: { ...binding, accountId: "12" } },
  ])("rejects independently read transaction identity mismatch: %j", (patch) => {
    expect(matchSePayTip({ ...evidence(), readback: { kind: "complete", transactions: [{ ...transaction, ...patch }] } })).toEqual({ kind: "review", reason: "identity_mismatch" });
  });

  test.each([
    { bankGateway: "DifferentBank" }, { accountNumber: "999999999999" }, { subAccount: "UNKNOWNVA" },
  ])("rejects webhook destination mismatch: %j", (patch) => {
    expect(matchSePayTip({ ...evidence(), event: { ...event, ...patch } })).toEqual({ kind: "review", reason: "destination_mismatch" });
  });

  test("requires an exact verified virtual-account mapping and a snapshot of that virtual account", () => {
    const mapped = { ...binding, subAccount: "VIRTUAL01" };
    const vaEvidence = { ...evidence(), binding: mapped, event: { ...event, subAccount: "VIRTUAL01" },
      readback: { kind: "complete" as const, transactions: [{ ...transaction, binding: mapped }] } };
    expect(matchSePayTip(vaEvidence)).toEqual({ kind: "review", reason: "destination_mismatch" });
    expect(matchSePayTip({ ...vaEvidence, intent: { ...intent, accountNumber: "VIRTUAL01" } }).kind).toBe("matched");
  });

  test.each([49_999, 50_001, 100_000])("never tolerates partial or excess transfers (%i VND)", (amountVnd) => {
    expect(matchSePayTip({ ...evidence(), event: { ...event, amountVnd } })).toEqual({ kind: "review", reason: "amount_mismatch" });
    expect(matchSePayTip({ ...evidence(), readback: { kind: "complete", transactions: [{ ...transaction, amountVnd }] } })).toEqual({ kind: "review", reason: "amount_mismatch" });
  });

  test("does not accept code/content ambiguity or an outgoing readback", () => {
    expect(matchSePayTip({ ...evidence(), event: { ...event, referenceStatus: "conflicting", reference: null } })).toEqual({ kind: "review", reason: "reference_mismatch" });
    expect(matchSePayTip({ ...evidence(), readback: { kind: "complete", transactions: [{ ...transaction, direction: "out" }] } })).toEqual({ kind: "review", reason: "direction_mismatch" });
    expect(matchSePayTip({ ...evidence(), readback: { kind: "complete", transactions: [{ ...transaction, reference: "PWFFFFFFFFFFFFFFFFFFFF" }] } })).toEqual({ kind: "review", reason: "reference_mismatch" });
  });

  test("rejects pre-cutover, pre-intent, future and conflicting bank times", () => {
    for (const occurredAt of [new Date("2026-09-24T00:00:59Z"), new Date("2026-09-24T00:01:59Z")]) {
      expect(matchSePayTip({ ...evidence(), event: { ...event, occurredAt }, readback: { kind: "complete", transactions: [{ ...transaction, occurredAt }] } })).toEqual({ kind: "review", reason: "before_cutover" });
    }
    for (const patch of [{ occurredAt: new Date("2026-09-24T00:03:01Z") }, { bankReference: "OTHER" }, { occurredAt: new Date("2026-09-24T00:06:00Z") }]) {
      expect(matchSePayTip({ ...evidence(), readback: { kind: "complete", transactions: [{ ...transaction, ...patch }] } })).toEqual({ kind: "review", reason: "time_mismatch" });
    }
  });

  test.each([NaN, Infinity, 50_000.5, 0, -1, Number.MAX_SAFE_INTEGER + 1])("rejects noncanonical numeric evidence (%s)", (amountVnd) => {
    expect(matchSePayTip({ ...evidence(), event: { ...event, amountVnd } })).toEqual({ kind: "review", reason: "invalid_evidence" });
  });
});
