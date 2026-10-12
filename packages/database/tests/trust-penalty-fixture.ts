import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { createEncryptionKeyring, encryptSensitiveField } from "@pawket/security";

export const penaltyAt = new Date("2026-10-10T00:00:00Z");

export async function seedPenaltySubject(client: postgres.Sql, userId: string = randomUUID()) {
  const ownerUserId = randomUUID(); const sourceCaseId = randomUUID();
  const applicationId = randomUUID(); const revisionId = randomUUID(); const capabilityId = randomUUID();
  const at = penaltyAt.toISOString();
  await client`insert into identity_users (id, name, email, canonical_email)
    values (${userId}, 'Subject', ${userId + "@example.test"}, ${userId + "@example.test"}) on conflict do nothing`;
  await client`insert into identity_users (id, name, email, canonical_email)
    values (${ownerUserId}, 'Owner', ${ownerUserId + "@example.test"}, ${ownerUserId + "@example.test"})`;
  await client.begin(async (tx) => {
    await tx`insert into trust_cases (id, kind, source_type, source_id, opened_at)
      values (${sourceCaseId}, 'report', 'commission_package', ${randomUUID()}, ${at})`;
    await tx`insert into trust_case_events (case_id, action, request_id, expected_version, resulting_version, after_state, occurred_at)
      values (${sourceCaseId}, 'opened', 'fixture', 0, 1, 'open', ${at})`;
  });
  await client`insert into creator_applications (id, user_id, state, created_at, updated_at)
    values (${applicationId}, ${userId}, 'approved', ${at}, ${at})`;
  await client`insert into creator_application_revisions (id, application_id, revision_number, created_at, updated_at)
    values (${revisionId}, ${applicationId}, 1, ${at}, ${at})`;
  await client`insert into identity_creator_capabilities (id, user_id, state, approved_application_id, approved_revision_id, created_at, updated_at)
    values (${capabilityId}, ${userId}, 'active', ${applicationId}, ${revisionId}, ${at}, ${at})`;
  return { userId, ownerUserId, sourceCaseId, applicationId, revisionId, capabilityId,
    actor: { userId: ownerUserId, sessionId: "owner-session", stepUpProofId: randomUUID() } };
}

export async function insertTestPenalty(client: postgres.Sql, subject: Awaited<ReturnType<typeof seedPenaltySubject>>, options: {
  kind?: string; restriction?: string | null; target?: string | null; endsAt?: Date | null; startsAt?: Date; explanation?: unknown; internalNote?: unknown;
} = {}) {
  const id = randomUUID(); const kind = options.kind ?? "suspension";
  const explanation = options.explanation ?? encryptSensitiveField({ keyring: createEncryptionKeyring({ activeKeyId: "schema-tests", keys: { "schema-tests": new Uint8Array(32).fill(73) } }),
    plaintext: "Synthetic explanation", binding: { recordType: "trust_penalties", recordId: id, fieldName: "explanation" } });
  const restriction = options.restriction ?? (kind === "restriction" ? "reporting" : null);
  const target = options.target ?? (kind === "suspension" || kind === "removal" ? "creator_capability" : null);
  const endsAt = options.endsAt === undefined ? (kind === "warning" || kind === "removal" ? null : new Date("2026-10-11T00:00:00Z")) : options.endsAt;
  await client`insert into trust_penalties (id, subject_user_id, kind, restriction, target, state, reason_category,
    explanation_envelope, internal_note_envelope, source_case_id, starts_at, ends_at, owner_user_id, owner_session_id, step_up_proof_id, request_id, created_at)
    values (${id}, ${subject.userId}, ${kind}, ${restriction}, ${target}, 'active', 'other', ${JSON.stringify(explanation)}::jsonb, ${options.internalNote === undefined ? null : JSON.stringify(options.internalNote)}::jsonb,
      ${subject.sourceCaseId}, ${(options.startsAt ?? penaltyAt).toISOString()}, ${endsAt?.toISOString() ?? null},
      ${subject.ownerUserId}, 'owner-session', ${subject.actor.stepUpProofId}, 'fixture', ${penaltyAt.toISOString()})`;
  return id;
}
