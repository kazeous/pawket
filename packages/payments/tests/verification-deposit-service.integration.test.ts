import { readdir, readFile } from "node:fs/promises";

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { identityUsers } from "@pawket/database";
import {
  createEncryptionKeyring,
  decryptSensitiveField,
  type EncryptionEnvelope,
} from "@pawket/security";
import * as payments from "../src/index.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for payments integration tests");

type ChallengeProjection = {
  id: string;
  amountVnd: number;
  reference: string | null;
  expiresAt: Date;
  replayed: boolean;
};

type ReconciliationProjection = {
  kind: "matched" | "unmatched";
  receiptId?: string;
  unmatchedId?: string;
  obligationId?: string;
  reason?: string;
};

type VerificationDepositService = {
  listRefundObligations(): Promise<Array<Record<string, unknown>>>;
  issueChallenge(input: {
    ownerUserId: string;
    ownerSessionId: string;
    stepUpProofId: string;
    applicationId: string;
    revisionId: string;
    accountVersionId: string;
    idempotencyKey: string;
    requestId: string;
  }): Promise<ChallengeProjection>;
  reportSent(input: {
    applicantUserId: string;
    challengeId: string;
    reportedSentAt: Date;
    idempotencyKey: string;
  }): Promise<{ state: string }>;
  reconcile(input: {
    ownerUserId: string;
    ownerSessionId: string;
    stepUpProofId: string;
    idempotencyKey: string;
    requestId: string;
    bankTransactionReference: string;
    actualAmountVnd: number;
    actualTransferReference: string;
    receivedAt: Date;
    sourceBankBin?: string;
    sourceAccountNumber?: string;
    privateNote: string;
  }): Promise<ReconciliationProjection>;
  revealRefundDestination(input: {
    ownerUserId: string;
    ownerSessionId: string;
    stepUpProofId: string;
    obligationId: string;
    requestId: string;
  }): Promise<{ bankBin: string; accountNumber: string; accountHolderLabel: string }>;
  recordRefund(input: {
    ownerUserId: string;
    ownerSessionId: string;
    stepUpProofId: string;
    obligationId: string;
    idempotencyKey: string;
    requestId: string;
    outcome: "sent" | "attention_required";
    actualAmountVnd?: number;
    outboundBankReference?: string;
    sentAt?: Date;
    attentionReason?: string;
  }): Promise<{ state: string }>;
  getApplicantStatus(input: { applicantUserId: string; applicationId: string }): Promise<{
    proofState: string;
    refundState: string | null;
    refundNotBefore: string | null;
    refundDue: string | null;
  }>;
};

type PaymentsExports = {
  createReceivingAccountService(input: unknown): {
    propose(input: Record<string, unknown>): Promise<{ referenceId: string }>;
  };
  createVerificationDepositService(input: unknown): VerificationDepositService;
  scanVerificationDepositRefundWindows(input: {
    db: unknown;
    now: Date;
  }): Promise<{
    dueSoon: number;
    dueToday: number;
    overdue: number;
    attention: number;
    outstandingAmountVnd: number;
  }>;
};

type LockedObligation = {
  state: string;
  amount_vnd: number;
  account_version_id: string;
  locked_account_number_envelope: EncryptionEnvelope;
  refund_not_before: string;
  refund_due: string;
};

const api = payments as unknown as Partial<PaymentsExports>;
const schemaName = `payments_verification_deposit_${process.pid}_${Date.now()}`;
const client = postgres(databaseUrl, { max: 1 });
const db = drizzle(client);
const migrationsDirectory = new URL("../../database/migrations/", import.meta.url);
const keyring = createEncryptionKeyring({
  activeKeyId: "payments-test-v1",
  keys: { "payments-test-v1": new Uint8Array(32).fill(31) },
});
const lookupHmacKey = new Uint8Array(32).fill(47);
const supportedBanks = { "970415": "VietinBank", "970436": "Vietcombank" } as const;
const applicationId = "10000000-0000-4000-8000-000000000001";
const revisionId = "10000000-0000-4000-8000-000000000002";
let accountVersionId = "";
let clock = new Date("2026-08-28T03:00:00.000Z");
let issuedChallengeId = "";
let issuedReference = "";
let replacementAccountVersionId = "";
const consumedProofs = new Set<string>();
const proofId = (sequence: number) =>
  `20000000-0000-4000-8000-${sequence.toString().padStart(12, "0")}`;

async function migrate(filename: string): Promise<void> {
  const migration = await readFile(new URL(filename, migrationsDirectory), "utf8");
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim()) await client.unsafe(statement);
  }
}

beforeAll(async () => {
  await client.unsafe(`create schema "${schemaName}"`);
  await client.unsafe(`set search_path to "${schemaName}", public`);
  for (const migration of (await readdir(migrationsDirectory))
    .filter((entry) => entry.endsWith(".sql"))
    .sort()) {
    await migrate(migration);
  }
  await db.insert(identityUsers).values([
    {
      id: "deposit-applicant",
      name: "Deposit Applicant",
      email: "deposit-applicant@example.com",
      canonicalEmail: "deposit-applicant@example.com",
      emailVerified: true,
      emailVerifiedAt: clock,
      emailVerificationProvenance: "password_email_challenge",
      createdAt: clock,
      updatedAt: clock,
    },
    {
      id: "deposit-owner",
      name: "Deposit Owner",
      email: "deposit-owner@example.com",
      canonicalEmail: "deposit-owner@example.com",
      emailVerified: true,
      emailVerifiedAt: clock,
      emailVerificationProvenance: "password_email_challenge",
      twoFactorEnabled: true,
      createdAt: clock,
      updatedAt: clock,
    },
  ]);

  expect(typeof api.createReceivingAccountService).toBe("function");
  const accountService = api.createReceivingAccountService!({
    db,
    keyring,
    lookupHmacKey,
    supportedBanks,
    now: () => clock,
  });
  const account = await accountService.propose({
    applicantUserId: "deposit-applicant",
    sessionId: "deposit-applicant-session",
    primaryAuthenticatedAt: new Date(clock.getTime() - 60_000),
    idempotencyKey: "deposit-account-proposal",
    bankBin: "970436",
    accountNumber: "001234567890",
    accountHolderLabel: "NGUYEN VAN A",
  });
  accountVersionId = account.referenceId;

  await client`
    insert into creator_applications (
      id, user_id, state, version, current_revision_id, created_at, updated_at
    ) values (
      ${applicationId}, 'deposit-applicant', 'draft', 1, ${revisionId}, ${clock.toISOString()}, ${clock.toISOString()}
    )
  `;
  await client`
    insert into creator_application_revisions (
      id, application_id, revision_number, artist_display_name, proposed_receiving_account_id,
      submitted_at, created_at, updated_at
    ) values (
      ${revisionId}, ${applicationId}, 1, 'Deposit Artist', ${accountVersionId}, null, ${clock.toISOString()}, ${clock.toISOString()}
    )
  `;
  await client`
    insert into system_business_calendar_versions (
      version, jurisdiction, time_zone, source_label, published_at, imported_at
    ) values ('vn-test-2026', 'VN', 'Asia/Ho_Chi_Minh', 'owner-config', ${clock.toISOString()}, ${clock.toISOString()})
  `;
  await client`
    insert into system_business_calendar_holidays (calendar_version, holiday_date, name)
    values ('vn-test-2026', '2026-09-02', 'National Day')
  `;
});

afterAll(async () => {
  await client.unsafe("set search_path to public");
  await client.unsafe(`drop schema if exists "${schemaName}" cascade`);
  await client.end();
});

function service(): VerificationDepositService {
  expect(typeof api.createVerificationDepositService).toBe("function");
  return api.createVerificationDepositService!({
    db,
    keyring,
    lookupHmacKey,
    supportedBanks,
    depositAmountVnd: 20_000,
    operatingAccount: {
      bankBin: "970415",
      bankName: "VietinBank",
      accountNumber: "999900001111",
      accountHolderLabel: "PAWKET OPERATIONS",
    },
    calendarVersion: "vn-test-2026",
    now: () => clock,
    consumeStepUpProof: async (_tx: unknown, proof: { proofId: string }) => {
      if (proof.proofId === proofId(999) || consumedProofs.has(proof.proofId)) return false;
      consumedProofs.add(proof.proofId);
      return true;
    },
  });
}

describe("verification-deposit service", () => {
  test("issues a single-display 72-hour challenge for a submitted or actively claimed revision", async () => {
    // Break caught: challenge creation before submission, through another owner's claim,
    // without step-up, or with reversible reference storage.
    const deposits = service();
    const issue = {
      ownerUserId: "deposit-owner",
      ownerSessionId: "deposit-owner-session",
      stepUpProofId: proofId(1),
      applicationId,
      revisionId,
      accountVersionId,
      idempotencyKey: "challenge-issue-one",
      requestId: "request.challenge.issue.one",
    };
    await expect(deposits.issueChallenge(issue)).rejects.toThrow(
      "Submitted or actively claimed application required",
    );
    consumedProofs.delete(proofId(1));

    await client`
      update creator_applications set state = 'submitted', version = 2, updated_at = ${clock.toISOString()}
      where id = ${applicationId}
    `;
    await client`
      update creator_application_revisions
      set short_introduction = 'A complete submitted verification-deposit fixture.',
          applicant_email = 'deposit-applicant@example.com',
          dob_envelope = '{"version":1}'::jsonb,
          portfolio_urls = '["https://portfolio.example.com/deposit-artist"]'::jsonb,
          primary_art_discipline = 'illustration',
          practice_description = 'Verification-deposit fixture practice description.',
          content_intent = 'general_audience_only',
          age_at_submission = 26,
          age_evaluated_on = '2026-08-28',
          submitted_at = ${clock.toISOString()},
          updated_at = ${clock.toISOString()}
      where id = ${revisionId}
    `;
    await client`
      update creator_applications
      set state = 'under_review',
          reviewer_user_id = 'deposit-applicant',
          review_claimed_at = ${clock.toISOString()},
          review_claim_expires_at = ${new Date(clock.getTime() + 30 * 60_000).toISOString()},
          updated_at = ${clock.toISOString()}
      where id = ${applicationId}
    `;
    await expect(deposits.issueChallenge(issue)).rejects.toThrow(
      "Submitted or actively claimed application required",
    );
    await client`
      update creator_applications
      set reviewer_user_id = 'deposit-owner', updated_at = ${clock.toISOString()}
      where id = ${applicationId}
    `;
    await expect(
      deposits.issueChallenge({ ...issue, stepUpProofId: proofId(999) }),
    ).rejects.toThrow("Owner TOTP step-up required");

    const issued = await deposits.issueChallenge(issue);
    expect(issued).toMatchObject({ amountVnd: 20_000, replayed: false });
    expect(issued.reference).toMatch(/^PV-[A-Z0-9]{26,64}$/u);
    expect(issued.expiresAt.toISOString()).toBe("2026-08-31T03:00:00.000Z");
    issuedChallengeId = issued.id;
    issuedReference = issued.reference!;

    const stored = await client<{ reference_hash: string }[]>`
      select reference_hash from payments_verification_deposit_challenges
      where id = ${issued.id}
    `;
    expect(stored[0]?.reference_hash).toMatch(/^sha256:v1:/u);
    expect(JSON.stringify(stored)).not.toContain(issued.reference!);

    const replayed = await deposits.issueChallenge(issue);
    expect(replayed).toMatchObject({ id: issued.id, reference: null, replayed: true });
    await client`
      update creator_applications
      set state = 'submitted',
          reviewer_user_id = null,
          review_claimed_at = null,
          review_claim_expires_at = null,
          updated_at = ${clock.toISOString()}
      where id = ${applicationId}
    `;
  });

  test("rejects a minimized receiving account before issuing a challenge", async () => {
    // Break caught: accepting a current-looking account whose retention sweep
    // already destroyed the ciphertext needed by later reconciliation.
    const minimizedApplicantId = "minimized-challenge-applicant";
    const minimizedApplicationId = "30000000-0000-4000-8000-000000000001";
    const minimizedRevisionId = "30000000-0000-4000-8000-000000000002";
    await db.insert(identityUsers).values({
      id: minimizedApplicantId,
      name: "Minimized Challenge Applicant",
      email: "minimized-challenge@example.com",
      canonicalEmail: "minimized-challenge@example.com",
      emailVerified: true,
      emailVerifiedAt: clock,
      emailVerificationProvenance: "password_email_challenge",
      createdAt: clock,
      updatedAt: clock,
    });
    const accountService = api.createReceivingAccountService!({
      db,
      keyring,
      lookupHmacKey,
      supportedBanks,
      now: () => clock,
    });
    const account = await accountService.propose({
      applicantUserId: minimizedApplicantId,
      sessionId: "minimized-challenge-session",
      primaryAuthenticatedAt: new Date(clock.getTime() - 60_000),
      idempotencyKey: "minimized-challenge-account",
      bankBin: "970436",
      accountNumber: "001234567891",
      accountHolderLabel: "NGUYEN VAN B",
    });
    await client`
      insert into creator_applications (
        id, user_id, state, version, current_revision_id, created_at, updated_at
      ) values (
        ${minimizedApplicationId}, ${minimizedApplicantId}, 'submitted', 2,
        ${minimizedRevisionId}, ${clock.toISOString()}, ${clock.toISOString()}
      )
    `;
    await client`
      insert into creator_application_revisions (
        id, application_id, revision_number, artist_display_name, short_introduction,
        applicant_email, dob_envelope, portfolio_urls, primary_art_discipline,
        practice_description, content_intent, proposed_receiving_account_id,
        age_at_submission, age_evaluated_on, submitted_at, created_at, updated_at
      ) values (
        ${minimizedRevisionId}, ${minimizedApplicationId}, 1, 'Minimized Artist',
        'A complete minimized-account challenge fixture.',
        'minimized-challenge@example.com', '{"version":1}'::jsonb,
        '["https://portfolio.example.com/minimized-artist"]'::jsonb,
        'illustration', 'Minimized-account fixture practice.',
        'general_audience_only', ${account.referenceId}, 26, '2026-08-28',
        ${clock.toISOString()}, ${clock.toISOString()}, ${clock.toISOString()}
      )
    `;
    await client`
      update payments_receiving_account_onboarding
      set account_number_envelope = null,
          account_holder_label_envelope = null,
          minimized_at = ${clock.toISOString()},
          updated_at = ${clock.toISOString()}
      where id = ${account.referenceId}
    `;

    await expect(
      service().issueChallenge({
        ownerUserId: "deposit-owner",
        ownerSessionId: "deposit-owner-session",
        stepUpProofId: proofId(20),
        applicationId: minimizedApplicationId,
        revisionId: minimizedRevisionId,
        accountVersionId: account.referenceId,
        idempotencyKey: "minimized-challenge-issue",
        requestId: "request.challenge.issue.minimized",
      }),
    ).rejects.toThrow("Submitted receiving account required");
    expect(consumedProofs.has(proofId(20))).toBe(false);
    expect(await client`
      select id from payments_verification_deposit_challenges
      where application_id = ${minimizedApplicationId}
    `).toHaveLength(0);
  });

  test("keeps applicant sent reports untrusted and routes mismatch receipts to unmatched review", async () => {
    // Break caught: applicant self-verification or accepting wrong amount/source metadata.
    const deposits = service();
    const report = await deposits.reportSent({
      applicantUserId: "deposit-applicant",
      challengeId: issuedChallengeId,
      reportedSentAt: clock,
      idempotencyKey: "deposit-report-one",
    });
    expect(report.state).toBe("sent_reported");
    const beforeReconciliation = await deposits.getApplicantStatus({
      applicantUserId: "deposit-applicant",
      applicationId,
    });
    expect(beforeReconciliation).toMatchObject({ proofState: "sent_reported", refundState: null });

    const wrongAmount = await deposits.reconcile({
      ownerUserId: "deposit-owner",
      ownerSessionId: "deposit-owner-session",
      stepUpProofId: proofId(2),
      idempotencyKey: "reconcile-wrong-amount",
      requestId: "request.reconcile.wrong.amount",
      bankTransactionReference: "BANK-TXN-WRONG-AMOUNT",
      actualAmountVnd: 19_999,
      actualTransferReference: "unknown-at-test-boundary",
      receivedAt: clock,
      sourceBankBin: "970436",
      sourceAccountNumber: "001234567890",
      privateNote: "Amount differs from challenge",
    });
    expect(wrongAmount).toMatchObject({ kind: "unmatched", reason: "amount_mismatch" });

    const counts = await client<{ obligations: number; unmatched: number }[]>`
      select
        (select count(*)::int from payments_verification_deposit_refund_obligations) as obligations,
        (select count(*)::int from payments_unmatched_deposits) as unmatched
    `;
    expect(counts[0]).toEqual({ obligations: 0, unmatched: 1 });
  });

  test("atomically verifies an exact receipt and locks the day-5/day-7 refund liability", async () => {
    // Break caught: partial proof without debt, decimal VND, source mismatch, or calendar-day calculation.
    const deposits = service();
    const [issuedAudit] = await client<{ request_id: string }[]>`
      select request_id from admin_audit_events where action = 'payments.challenge.issue'
    `;
    expect(issuedAudit?.request_id).toBe("request.challenge.issue.one");

    const matched = await deposits.reconcile({
      ownerUserId: "deposit-owner",
      ownerSessionId: "deposit-owner-session",
      stepUpProofId: proofId(3),
      idempotencyKey: "reconcile-match-one",
      requestId: "request.reconcile.match.one",
      bankTransactionReference: "BANK-TXN-MATCH-ONE",
      actualAmountVnd: 20_000,
      actualTransferReference: issuedReference,
      receivedAt: clock,
      sourceBankBin: "970436",
      sourceAccountNumber: "001234567890",
      privateNote: "Matched against bank ledger",
    });
    expect(matched.kind).toBe("matched");
    expect(matched.receiptId).toBeTruthy();
    expect(matched.obligationId).toBeTruthy();

    const [obligation] = await client<LockedObligation[]>`
      select state, amount_vnd, account_version_id, locked_account_number_envelope,
             refund_not_before, refund_due
      from payments_verification_deposit_refund_obligations
      where id = ${matched.obligationId!}
    `;
    expect(obligation).toMatchObject({
      state: "pending_window",
      amount_vnd: 20_000,
      account_version_id: accountVersionId,
      refund_not_before: "2026-09-07",
      refund_due: "2026-09-09",
    });
    const ownerList = await deposits.listRefundObligations();
    expect(ownerList).toEqual([
      expect.objectContaining({
        id: matched.obligationId,
        applicantUserId: "deposit-applicant",
        artistDisplayName: "Deposit Artist",
        amountVnd: 20_000,
        bankName: "Vietcombank",
        maskedSuffix: "•••• 7890",
        state: "pending_window",
      }),
    ]);
    expect(JSON.stringify(ownerList)).not.toContain("001234567890");
    expect(JSON.stringify(ownerList)).not.toContain("accountHolderLabel");
    expect(
      decryptSensitiveField({
        envelope: obligation!.locked_account_number_envelope,
        binding: {
          recordType: "payments_refund_obligation",
          recordId: matched.obligationId!,
          fieldName: "account_number",
        },
        keyring,
      }),
    ).toBe("001234567890");

    const atomic = await client<{ proof_state: string; receipts: number; obligations: number; events: number }[]>`
      select
        (select proof_state from payments_receiving_account_onboarding where id = ${accountVersionId}) as proof_state,
        (select count(*)::int from payments_verification_deposit_receipts where result = 'matched') as receipts,
        (select count(*)::int from payments_verification_deposit_refund_obligations) as obligations,
        (select count(*)::int from system_outbox where aggregate_id = ${matched.obligationId!}) as events
    `;
    expect(atomic[0]).toEqual({ proof_state: "verified", receipts: 1, obligations: 1, events: 2 });
    await expect(
      client`
        update payments_verification_deposit_refund_obligations
        set locked_bank_bin = '970415'
        where id = ${matched.obligationId!}
      `,
    ).rejects.toThrow("payments refund obligation binding is immutable");
    await expect(
      client`
        update payments_receiving_account_onboarding
        set account_number_envelope = '{}'::jsonb
        where id = ${accountVersionId}
      `,
    ).rejects.toThrow("payments receiving account versions are immutable");
    await expect(
      client`delete from creator_applications where id = ${applicationId}`,
    ).rejects.toThrow();
    await expect(
      client`delete from identity_users where id = 'deposit-applicant'`,
    ).rejects.toThrow();

    const duplicate = await deposits.reconcile({
      ownerUserId: "deposit-owner",
      ownerSessionId: "deposit-owner-session",
      stepUpProofId: proofId(4),
      idempotencyKey: "reconcile-duplicate-one",
      requestId: "request.reconcile.duplicate.one",
      bankTransactionReference: "BANK-TXN-DUPLICATE",
      actualAmountVnd: 20_000,
      actualTransferReference: issuedReference,
      receivedAt: clock,
      sourceBankBin: "970436",
      sourceAccountNumber: "001234567890",
      privateNote: "Duplicate bank row",
    });
    expect(duplicate).toMatchObject({ kind: "unmatched", reason: "duplicate" });
  });

  test("emits each due-soon, due-today, and overdue liability signal once without moving funds", async () => {
    // Break caught: worker retry duplicating alerts, postponing due dates, or recording an automated refund.
    expect(typeof api.scanVerificationDepositRefundWindows).toBe("function");

    const dueSoon = await api.scanVerificationDepositRefundWindows!({
      db,
      now: new Date("2026-09-08T03:00:00.000Z"),
    });
    expect(dueSoon).toEqual({
      dueSoon: 1,
      dueToday: 0,
      overdue: 0,
      attention: 0,
      outstandingAmountVnd: 20_000,
    });
    await api.scanVerificationDepositRefundWindows!({
      db,
      now: new Date("2026-09-08T03:00:00.000Z"),
    });
    const dueToday = await api.scanVerificationDepositRefundWindows!({
      db,
      now: new Date("2026-09-09T03:00:00.000Z"),
    });
    expect(dueToday).toMatchObject({ dueSoon: 0, dueToday: 1, overdue: 0 });
    const overdue = await api.scanVerificationDepositRefundWindows!({
      db,
      now: new Date("2026-09-10T03:00:00.000Z"),
    });
    expect(overdue).toMatchObject({ dueSoon: 0, dueToday: 0, overdue: 1 });

    const events = await client<{ event_type: string; count: number }[]>`
      select event_type, count(*)::int as count from system_outbox
      where event_type in (
        'payments.verification_deposit_refund_due_soon.v1',
        'payments.verification_deposit_refund_due_today.v1',
        'payments.verification_deposit_refund_overdue.v1'
      )
      group by event_type order by event_type
    `;
    expect(events).toEqual([
      { event_type: "payments.verification_deposit_refund_due_soon.v1", count: 1 },
      { event_type: "payments.verification_deposit_refund_due_today.v1", count: 1 },
      { event_type: "payments.verification_deposit_refund_overdue.v1", count: 1 },
    ]);
    const [state] = await client<{ state: string; refunds: number }[]>`
      select
        (select state from payments_verification_deposit_refund_obligations limit 1) as state,
        (select count(*)::int from payments_verification_deposit_refunds) as refunds
    `;
    expect(state).toEqual({ state: "attention_required", refunds: 0 });
    clock = new Date("2026-08-28T03:00:00.000Z");
  });

  test("reveals and refunds only the locked destination within the allowed window", async () => {
    // Break caught: early refund, redirect after account replacement, duplicate refund, or missing fresh owner proof.
    clock = new Date("2026-08-28T03:00:00.000Z");
    const deposits = service();
    const [obligation] = await client<{ id: string }[]>`
      select id from payments_verification_deposit_refund_obligations
    `;
    await expect(
      deposits.recordRefund({
        ownerUserId: "deposit-owner",
        ownerSessionId: "deposit-owner-session",
        stepUpProofId: proofId(5),
        obligationId: obligation!.id,
        idempotencyKey: "refund-too-early",
        requestId: "request.refund.too.early",
        outcome: "sent",
        actualAmountVnd: 20_000,
        outboundBankReference: "OUTBOUND-EARLY",
        sentAt: clock,
      }),
    ).rejects.toThrow("Refund window has not opened");
    consumedProofs.delete(proofId(5));

    expect(typeof api.createReceivingAccountService).toBe("function");
    const replacement = await api.createReceivingAccountService!({
      db,
      keyring,
      lookupHmacKey,
      supportedBanks,
      now: () => clock,
    }).propose({
      applicantUserId: "deposit-applicant",
      sessionId: "deposit-applicant-session",
      primaryAuthenticatedAt: new Date(clock.getTime() - 60_000),
      idempotencyKey: "replacement-after-liability",
      bankBin: "970415",
      accountNumber: "777766665555",
      accountHolderLabel: "NGUYEN VAN A",
    });
    replacementAccountVersionId = replacement.referenceId;

    clock = new Date("2026-09-07T03:00:00.000Z");
    const destination = await deposits.revealRefundDestination({
      ownerUserId: "deposit-owner",
      ownerSessionId: "deposit-owner-session",
      stepUpProofId: proofId(6),
      obligationId: obligation!.id,
      requestId: "request.refund.reveal",
    });
    expect(destination).toEqual({
      bankBin: "970436",
      accountNumber: "001234567890",
      accountHolderLabel: "NGUYEN VAN A",
    });

    await expect(
      deposits.recordRefund({
        ownerUserId: "deposit-owner",
        ownerSessionId: "deposit-owner-session",
        stepUpProofId: proofId(16),
        obligationId: obligation!.id,
        idempotencyKey: "refund-wrong-amount",
        requestId: "request.refund.wrong.amount",
        outcome: "sent",
        actualAmountVnd: 19_999,
        outboundBankReference: "BANK-OUTBOUND-WRONG-AMOUNT",
        sentAt: clock,
      }),
    ).rejects.toThrow("Refund amount must match the obligation");

    const sent = await deposits.recordRefund({
      ownerUserId: "deposit-owner",
      ownerSessionId: "deposit-owner-session",
      stepUpProofId: proofId(7),
      obligationId: obligation!.id,
      idempotencyKey: "refund-record-one",
      requestId: "request.refund.record.one",
      outcome: "sent",
      actualAmountVnd: 20_000,
      outboundBankReference: "BANK-OUTBOUND-00001234",
      sentAt: clock,
    });
    expect(sent.state).toBe("sent");
    await expect(
      deposits.recordRefund({
        ownerUserId: "deposit-owner",
        ownerSessionId: "deposit-owner-session",
        stepUpProofId: proofId(8),
        obligationId: obligation!.id,
        idempotencyKey: "refund-record-two",
        requestId: "request.refund.record.two",
        outcome: "sent",
        actualAmountVnd: 20_000,
        outboundBankReference: "BANK-OUTBOUND-SECOND",
        sentAt: clock,
      }),
    ).rejects.toThrow("Refund was already recorded");

    const status = await deposits.getApplicantStatus({
      applicantUserId: "deposit-applicant",
      applicationId,
    });
    expect(status).toMatchObject({
      proofState: "verified",
      refundState: "sent",
      refundNotBefore: "2026-09-07",
      refundDue: "2026-09-09",
    });
  });

  test("keeps late, unidentified, wrong-source, and two-tab receipts unmatched", async () => {
    // Break caught: a mismatch proving control or two concurrent owner tabs creating two debts.
    const secondApplicationId = "10000000-0000-4000-8000-000000000101";
    const secondRevisionId = "10000000-0000-4000-8000-000000000102";
    clock = new Date("2026-09-07T03:00:00.000Z");
    await client`
      update creator_applications
      set state = 'withdrawn', version = version + 1, updated_at = ${clock.toISOString()}
      where id = ${applicationId}
    `;
    const [retained] = await client<{ count: number }[]>`
      select count(*)::int as count
      from payments_verification_deposit_refund_obligations
      where challenge_id = ${issuedChallengeId}
    `;
    expect(retained?.count).toBe(1);
    await client`
      insert into creator_applications (
        id, user_id, state, version, current_revision_id, created_at, updated_at
      ) values (
        ${secondApplicationId}, 'deposit-applicant', 'submitted', 2, ${secondRevisionId},
        ${clock.toISOString()}, ${clock.toISOString()}
      )
    `;
    await client`
      insert into creator_application_revisions (
        id, application_id, revision_number, artist_display_name, short_introduction,
        applicant_email, dob_envelope, portfolio_urls, primary_art_discipline,
        practice_description, content_intent, proposed_receiving_account_id,
        age_at_submission, age_evaluated_on, submitted_at, created_at, updated_at
      ) values (
        ${secondRevisionId}, ${secondApplicationId}, 1, 'Deposit Artist Two',
        'A complete second verification-deposit fixture.',
        'deposit-applicant@example.com', '{"version":1}'::jsonb,
        '["https://portfolio.example.com/deposit-artist-two"]'::jsonb,
        'illustration', 'Second verification-deposit fixture practice description.',
        'general_audience_only', ${replacementAccountVersionId}, 26, '2026-09-07',
        ${clock.toISOString()}, ${clock.toISOString()}, ${clock.toISOString()}
      )
    `;
    const deposits = service();
    const issued = await deposits.issueChallenge({
      ownerUserId: "deposit-owner",
      ownerSessionId: "deposit-owner-session",
      stepUpProofId: proofId(9),
      applicationId: secondApplicationId,
      revisionId: secondRevisionId,
      accountVersionId: replacementAccountVersionId,
      idempotencyKey: "challenge-issue-second",
      requestId: "request.challenge.issue.second",
    });

    clock = new Date("2026-09-11T03:00:00.000Z");
    const baseReceipt = {
      ownerUserId: "deposit-owner",
      ownerSessionId: "deposit-owner-session",
      actualAmountVnd: 20_000,
      actualTransferReference: issued.reference!,
      receivedAt: new Date("2026-09-08T03:00:00.000Z"),
      sourceBankBin: "970415",
      sourceAccountNumber: "777766665555",
      privateNote: "Second challenge ledger review",
    };
    const unidentified = await deposits.reconcile({
      ...baseReceipt,
      stepUpProofId: proofId(10),
      idempotencyKey: "reconcile-unidentified",
      requestId: "request.reconcile.unidentified",
      bankTransactionReference: "BANK-TXN-UNIDENTIFIED",
      sourceBankBin: undefined,
      sourceAccountNumber: undefined,
    });
    expect(unidentified).toMatchObject({ kind: "unmatched", reason: "unidentified_source" });

    const wrongSource = await deposits.reconcile({
      ...baseReceipt,
      stepUpProofId: proofId(11),
      idempotencyKey: "reconcile-wrong-source",
      requestId: "request.reconcile.wrong.source",
      bankTransactionReference: "BANK-TXN-WRONG-SOURCE",
      sourceBankBin: "970436",
      sourceAccountNumber: "123456789999",
    });
    expect(wrongSource).toMatchObject({ kind: "unmatched", reason: "source_mismatch" });

    const late = await deposits.reconcile({
      ...baseReceipt,
      stepUpProofId: proofId(12),
      idempotencyKey: "reconcile-late-second",
      requestId: "request.reconcile.late.second",
      bankTransactionReference: "BANK-TXN-LATE-SECOND",
      receivedAt: clock,
    });
    expect(late).toMatchObject({ kind: "unmatched", reason: "late" });

    const results = await Promise.all([
      deposits.reconcile({
        ...baseReceipt,
        stepUpProofId: proofId(13),
        idempotencyKey: "reconcile-two-tab-one",
        requestId: "request.reconcile.two.tab.one",
        bankTransactionReference: "BANK-TXN-TWO-TAB-ONE",
      }),
      deposits.reconcile({
        ...baseReceipt,
        stepUpProofId: proofId(14),
        idempotencyKey: "reconcile-two-tab-two",
        requestId: "request.reconcile.two.tab.two",
        bankTransactionReference: "BANK-TXN-TWO-TAB-TWO",
      }),
    ]);
    expect(results.filter((result) => result.kind === "matched")).toHaveLength(1);
    expect(
      results.filter((result) => result.kind === "unmatched" && result.reason === "duplicate"),
    ).toHaveLength(1);
    const [counts] = await client<{ receipts: number; obligations: number }[]>`
      select
        (select count(*)::int from payments_verification_deposit_receipts
          where challenge_id = ${issued.id}) as receipts,
        (select count(*)::int from payments_verification_deposit_refund_obligations
          where challenge_id = ${issued.id}) as obligations
    `;
    expect(counts).toEqual({ receipts: 1, obligations: 1 });

    const matchedResult = results.find((result) => result.kind === "matched");
    expect(matchedResult?.kind).toBe("matched");
    clock = new Date("2026-09-15T03:00:00.000Z");
    const attentionCommand = {
      ownerUserId: "deposit-owner",
      ownerSessionId: "deposit-owner-session",
      stepUpProofId: proofId(15),
      obligationId: matchedResult!.obligationId!,
      idempotencyKey: "refund-attention-second",
      requestId: "request.refund.attention.second",
      outcome: "attention_required" as const,
      attentionReason: "outbound_transfer_rejected",
    };
    await expect(deposits.recordRefund(attentionCommand)).resolves.toEqual({
      state: "attention_required",
    });
    await expect(deposits.recordRefund(attentionCommand)).resolves.toEqual({
      state: "attention_required",
    });
    const [attentionCount] = await client<{ count: number }[]>`
      select count(*)::int as count from payments_verification_deposit_refunds
      where obligation_id = ${matchedResult!.obligationId!}
        and outcome = 'attention_required'
    `;
    expect(attentionCount?.count).toBe(1);
  });
});
