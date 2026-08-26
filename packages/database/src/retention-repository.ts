import { sql, type SQL } from "drizzle-orm";

import type { PawketDatabase, PawketTransaction } from "./client.js";
import { systemRetentionRuns } from "./schema.js";

export const RETENTION_DATASETS = [
  "provisional_accounts",
  "verifications",
  "sessions",
  "receiving_accounts",
  "application_content",
  "security_throttles",
] as const;

export type RetentionDataset = (typeof RETENTION_DATASETS)[number];
export type RetentionMode = "report_only" | "enforce";

export type RetentionDatasetResult = {
  dataset: RetentionDataset;
  cutoff: Date;
  candidateCount: number;
  protectedCount: number;
  processedCount: number;
  outcome: "completed" | "paused" | "failed";
};

type CountRow = { candidate_count: number; eligible_count: number };

const DAY_MS = 24 * 60 * 60 * 1_000;

function cutoffFor(dataset: RetentionDataset, now: Date): Date {
  const days =
    dataset === "provisional_accounts" || dataset === "verifications"
      ? 7
      : dataset === "application_content"
        ? 180
        : 30;
  return new Date(now.getTime() - days * DAY_MS);
}

function activeHold(
  dataset: RetentionDataset,
  subjectType:
    | "user"
    | "verification"
    | "session"
    | "security_throttle"
    | "receiving_account"
    | "creator_application",
  subjectId: SQL,
): SQL {
  return sql`exists(
    select 1 from system_retention_holds h
    where h.dataset = ${dataset}
      and h.subject_type = ${subjectType}
      and h.subject_id = ${subjectId}
      and h.released_at is null
  )`;
}

function countQuery(dataset: RetentionDataset, cutoff: Date, now: Date): SQL {
  const cutoffIso = cutoff.toISOString();
  const nowIso = now.toISOString();
  switch (dataset) {
    case "provisional_accounts":
      return sql`
        with candidates as (
          select u.id,
            exists(select 1 from identity_role_grants r where r.user_id = u.id) or
            exists(select 1 from creator_applications a where a.user_id = u.id or a.reviewer_user_id = u.id) or
            exists(select 1 from creator_application_attestations a where a.actor_user_id = u.id) or
            exists(select 1 from creator_application_decisions d where d.actor_user_id = u.id) or
            exists(select 1 from identity_creator_capabilities c where c.user_id = u.id) or
            exists(select 1 from identity_creator_capability_events e where e.actor_user_id = u.id) or
            exists(select 1 from payments_receiving_account_onboarding p where p.applicant_user_id = u.id) or
            exists(select 1 from payments_verification_deposit_challenges p where p.issued_by_owner_user_id = u.id) or
            exists(select 1 from payments_verification_deposit_reports p where p.applicant_user_id = u.id) or
            exists(select 1 from payments_verification_deposit_receipts p where p.reconciled_by_owner_user_id = u.id) or
            exists(select 1 from payments_verification_deposit_refund_obligations p where p.applicant_user_id = u.id) or
            exists(select 1 from payments_verification_deposit_refunds p where p.recorded_by_owner_user_id = u.id) or
            exists(select 1 from payments_unmatched_deposits p where p.reconciled_by_owner_user_id = u.id) or
            exists(select 1 from admin_audit_events a where a.actor_user_id = u.id or (a.subject_type = 'user' and a.subject_id = u.id)) or
            exists(select 1 from system_command_idempotency c where c.actor_user_id = u.id) or
            ${activeHold("provisional_accounts", "user", sql`u.id`)} or
            exists(
              select 1 from identity_verifications v
              where v.user_id = u.id and v.purpose = 'email_verification'
                and v.consumed_at is null and v.expires_at >= ${nowIso}::timestamptz
            )
              as protected
          from identity_users u
          where u.email_verified = false and u.created_at < ${cutoffIso}::timestamptz
        )
        select count(*)::int candidate_count,
          count(*) filter (where not protected)::int eligible_count
        from candidates`;
    case "verifications":
      return sql`
        with candidates as (
          select v.id,
            ${activeHold("verifications", "verification", sql`v.id`)} or
            ${activeHold("verifications", "user", sql`v.user_id`)} as protected
          from identity_verifications v
          where coalesce(v.consumed_at, v.expires_at) < ${cutoffIso}::timestamptz
        )
        select count(*)::int candidate_count,
          count(*) filter (where not protected)::int eligible_count
        from candidates`;
    case "sessions":
      return sql`
        with candidates as (
          select s.id,
            ${activeHold("sessions", "session", sql`s.id`)} or
            ${activeHold("sessions", "user", sql`s.user_id`)} as protected
          from identity_sessions s
          where coalesce(s.revoked_at, s.expires_at) < ${cutoffIso}::timestamptz
        )
        select count(*)::int candidate_count,
          count(*) filter (where not protected)::int eligible_count
        from candidates`;
    case "security_throttles":
      return sql`
        with candidates as (
          select s.id,
            ${activeHold("security_throttles", "security_throttle", sql`s.id::text`)} as protected
          from identity_security_throttles s
          where s.updated_at < ${cutoffIso}::timestamptz
        )
        select count(*)::int candidate_count,
          count(*) filter (where not protected)::int eligible_count
        from candidates`;
    case "receiving_accounts":
      return sql`
        with candidates as (
          select p.id,
            exists(select 1 from identity_creator_capabilities c where c.user_id = p.applicant_user_id) or
            exists(
              select 1 from creator_application_revisions r
              join creator_applications a on a.id = r.application_id
              where r.proposed_receiving_account_id = p.id::text
                and a.current_revision_id = r.id
                and a.state in ('draft','submitted','under_review','changes_requested')
            ) or
            exists(
              select 1 from payments_verification_deposit_challenges c
              where c.account_version_id = p.id and c.state in ('issued','sent_reported')
            ) or
            exists(select 1 from payments_verification_deposit_refund_obligations o where o.account_version_id = p.id and o.state in ('pending_window','ready','attention_required')) or
            exists(
              select 1 from payments_unmatched_deposits u
              join payments_verification_deposit_challenges c on c.id = u.possible_challenge_id
              where c.account_version_id = p.id and u.refund_liability_state in ('unknown','pending','attention_required')
            ) or
            ${activeHold("receiving_accounts", "receiving_account", sql`p.id::text`)} or
            ${activeHold("receiving_accounts", "user", sql`p.applicant_user_id`)} as protected
          from payments_receiving_account_onboarding p
          where p.minimized_at is null
            and exists (
              select 1 from creator_application_revisions r
              join creator_applications a on a.id = r.application_id
              where r.proposed_receiving_account_id = p.id::text
                and a.state in ('withdrawn','rejected') and a.updated_at < ${cutoffIso}::timestamptz
                and (a.state <> 'rejected' or a.cooldown_until < ${nowIso}::timestamptz)
            )
        )
        select count(*)::int candidate_count,
          count(*) filter (where not protected)::int eligible_count
        from candidates`;
    case "application_content":
      return sql`
        with candidates as (
          select a.id,
            exists(select 1 from identity_creator_capabilities c where c.approved_application_id = a.id) or
            exists(
              select 1 from payments_verification_deposit_refund_obligations o
              join payments_verification_deposit_challenges c on c.id = o.challenge_id
              where c.application_id = a.id and o.state in ('pending_window','ready','attention_required')
            ) or
            exists(
              select 1 from payments_unmatched_deposits u
              join payments_verification_deposit_challenges c on c.id = u.possible_challenge_id
              where c.application_id = a.id and u.refund_liability_state in ('unknown','pending','attention_required')
            ) or
            ${activeHold("application_content", "creator_application", sql`a.id::text`)} or
            ${activeHold("application_content", "user", sql`a.user_id`)} as protected
          from creator_applications a
          where a.state in ('withdrawn','rejected') and a.updated_at < ${cutoffIso}::timestamptz
            and (a.state <> 'rejected' or a.cooldown_until < ${nowIso}::timestamptz)
            and exists(select 1 from creator_application_revisions r where r.application_id = a.id and r.minimized_at is null)
        )
        select count(*)::int candidate_count,
          count(*) filter (where not protected)::int eligible_count
        from candidates`;
  }
}

async function countCandidates(
  tx: PawketTransaction,
  dataset: RetentionDataset,
  cutoff: Date,
  now: Date,
): Promise<{ candidateCount: number; eligibleCount: number }> {
  const rows = await tx.execute<CountRow>(countQuery(dataset, cutoff, now));
  const row = rows[0];
  return {
    candidateCount: Number(row?.candidate_count ?? 0),
    eligibleCount: Number(row?.eligible_count ?? 0),
  };
}

async function enforceDataset(
  tx: PawketTransaction,
  dataset: RetentionDataset,
  cutoff: Date,
  now: Date,
  batchSize: number,
): Promise<number> {
  const cutoffIso = cutoff.toISOString();
  const nowIso = now.toISOString();
  let rows: Array<Record<string, unknown>>;
  switch (dataset) {
    case "verifications":
      rows = await tx.execute(sql`
        with selected as (
          select v.id from identity_verifications v
          where coalesce(v.consumed_at, v.expires_at) < ${cutoffIso}::timestamptz
            and not ${activeHold("verifications", "verification", sql`v.id`)}
            and not ${activeHold("verifications", "user", sql`v.user_id`)}
          order by coalesce(v.consumed_at, v.expires_at), v.id
          limit ${batchSize} for update skip locked
        ) delete from identity_verifications v using selected s where v.id = s.id returning v.id`);
      break;
    case "sessions":
      rows = await tx.execute(sql`
        with selected as (
          select s.id from identity_sessions s
          where coalesce(s.revoked_at, s.expires_at) < ${cutoffIso}::timestamptz
            and not ${activeHold("sessions", "session", sql`s.id`)}
            and not ${activeHold("sessions", "user", sql`s.user_id`)}
          order by coalesce(s.revoked_at, s.expires_at), s.id
          limit ${batchSize} for update skip locked
        ) delete from identity_sessions s using selected x where s.id = x.id returning s.id`);
      break;
    case "security_throttles":
      rows = await tx.execute(sql`
        with selected as (
          select s.id from identity_security_throttles s
          where s.updated_at < ${cutoffIso}::timestamptz
            and not ${activeHold("security_throttles", "security_throttle", sql`s.id::text`)}
          order by s.updated_at, s.id limit ${batchSize} for update skip locked
        ) delete from identity_security_throttles s using selected x where s.id = x.id returning s.id`);
      break;
    case "provisional_accounts":
      rows = await tx.execute(sql`
        with selected as (
          select u.id from identity_users u
          where u.email_verified = false and u.created_at < ${cutoffIso}::timestamptz
            and not exists(select 1 from identity_role_grants r where r.user_id = u.id)
            and not exists(select 1 from creator_applications a where a.user_id = u.id or a.reviewer_user_id = u.id)
            and not exists(select 1 from creator_application_attestations a where a.actor_user_id = u.id)
            and not exists(select 1 from creator_application_decisions d where d.actor_user_id = u.id)
            and not exists(select 1 from identity_creator_capabilities c where c.user_id = u.id)
            and not exists(select 1 from identity_creator_capability_events e where e.actor_user_id = u.id)
            and not exists(select 1 from payments_receiving_account_onboarding p where p.applicant_user_id = u.id)
            and not exists(select 1 from payments_verification_deposit_challenges p where p.issued_by_owner_user_id = u.id)
            and not exists(select 1 from payments_verification_deposit_reports p where p.applicant_user_id = u.id)
            and not exists(select 1 from payments_verification_deposit_receipts p where p.reconciled_by_owner_user_id = u.id)
            and not exists(select 1 from payments_verification_deposit_refund_obligations p where p.applicant_user_id = u.id)
            and not exists(select 1 from payments_verification_deposit_refunds p where p.recorded_by_owner_user_id = u.id)
            and not exists(select 1 from payments_unmatched_deposits p where p.reconciled_by_owner_user_id = u.id)
            and not exists(select 1 from admin_audit_events a where a.actor_user_id = u.id or (a.subject_type = 'user' and a.subject_id = u.id))
            and not exists(select 1 from system_command_idempotency c where c.actor_user_id = u.id)
            and not ${activeHold("provisional_accounts", "user", sql`u.id`)}
            and not exists(
              select 1 from identity_verifications v
              where v.user_id = u.id and v.purpose = 'email_verification'
                and v.consumed_at is null and v.expires_at >= ${nowIso}::timestamptz
            )
          order by u.created_at, u.id limit ${batchSize} for update skip locked
        ) delete from identity_users u using selected s where u.id = s.id returning u.id`);
      break;
    case "receiving_accounts":
      rows = await tx.execute(sql`
        with selected as (
          select p.id from payments_receiving_account_onboarding p
          where p.minimized_at is null
            and exists (
              select 1 from creator_application_revisions r join creator_applications a on a.id = r.application_id
              where r.proposed_receiving_account_id = p.id::text and a.state in ('withdrawn','rejected')
                and a.updated_at < ${cutoffIso}::timestamptz and (a.state <> 'rejected' or a.cooldown_until < ${nowIso}::timestamptz)
            )
            and not exists(select 1 from identity_creator_capabilities c where c.user_id = p.applicant_user_id)
            and not exists(
              select 1 from creator_application_revisions r join creator_applications a on a.id = r.application_id
              where r.proposed_receiving_account_id = p.id::text and a.current_revision_id = r.id
                and a.state in ('draft','submitted','under_review','changes_requested')
            )
            and not exists(
              select 1 from payments_verification_deposit_challenges c
              where c.account_version_id = p.id and c.state in ('issued','sent_reported')
            )
            and not exists(select 1 from payments_verification_deposit_refund_obligations o where o.account_version_id = p.id and o.state in ('pending_window','ready','attention_required'))
            and not exists(
              select 1 from payments_unmatched_deposits u join payments_verification_deposit_challenges c on c.id = u.possible_challenge_id
              where c.account_version_id = p.id and u.refund_liability_state in ('unknown','pending','attention_required')
            )
            and not ${activeHold("receiving_accounts", "receiving_account", sql`p.id::text`)}
            and not ${activeHold("receiving_accounts", "user", sql`p.applicant_user_id`)}
          order by p.updated_at, p.id limit ${batchSize} for update skip locked
        ) update payments_receiving_account_onboarding p
          set account_number_envelope = null, account_holder_label_envelope = null,
              minimized_at = ${nowIso}::timestamptz, updated_at = ${nowIso}::timestamptz
          from selected s where p.id = s.id returning p.id`);
      break;
    case "application_content":
      rows = await tx.execute(sql`
        with selected as (
          select a.id from creator_applications a
          where a.state in ('withdrawn','rejected') and a.updated_at < ${cutoffIso}::timestamptz
            and (a.state <> 'rejected' or a.cooldown_until < ${nowIso}::timestamptz)
            and exists(select 1 from creator_application_revisions r where r.application_id = a.id and r.minimized_at is null)
            and not exists(select 1 from identity_creator_capabilities c where c.approved_application_id = a.id)
            and not exists(
              select 1 from payments_verification_deposit_refund_obligations o join payments_verification_deposit_challenges c on c.id = o.challenge_id
              where c.application_id = a.id and o.state in ('pending_window','ready','attention_required')
            )
            and not exists(
              select 1 from payments_unmatched_deposits u join payments_verification_deposit_challenges c on c.id = u.possible_challenge_id
              where c.application_id = a.id and u.refund_liability_state in ('unknown','pending','attention_required')
            )
            and not ${activeHold("application_content", "creator_application", sql`a.id::text`)}
            and not ${activeHold("application_content", "user", sql`a.user_id`)}
          order by a.updated_at, a.id limit ${batchSize} for update skip locked
        ), updated as (
          update creator_application_revisions r
          set artist_display_name = null, applicant_email = null, dob_envelope = null,
              portfolio_urls = null, short_introduction = null, primary_art_discipline = null,
              practice_description = null, content_intent = null,
              proposed_receiving_account_id = null, minimized_at = ${nowIso}::timestamptz, updated_at = ${nowIso}::timestamptz
          from selected s where r.application_id = s.id and r.minimized_at is null
          returning r.application_id
        ) select distinct application_id from updated`);
      break;
  }
  return rows.length;
}

async function recordRun(
  tx: PawketTransaction,
  input: RetentionDatasetResult & { policyVersion: string; mode: RetentionMode; startedAt: Date; completedAt: Date },
): Promise<void> {
  await tx.insert(systemRetentionRuns).values({
    policyVersion: input.policyVersion,
    mode: input.mode,
    dataset: input.dataset,
    cutoff: input.cutoff,
    candidateCount: input.candidateCount,
    protectedCount: input.protectedCount,
    processedCount: input.processedCount,
    outcome: input.outcome,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
  });
}

export async function runRetentionSweep(input: {
  db: PawketDatabase;
  now: Date;
  mode: RetentionMode;
  policyVersion: string;
  enforcementPaused: boolean;
  batchSize: number;
}): Promise<RetentionDatasetResult[]> {
  const results: RetentionDatasetResult[] = [];
  for (const dataset of RETENTION_DATASETS) {
    const startedAt = new Date();
    const cutoff = cutoffFor(dataset, input.now);
    try {
      const result = await input.db.transaction(async (tx) => {
        await tx.execute(sql`
          select pg_advisory_xact_lock(
            hashtextextended('pawket.retention.' || ${dataset}::text, 0)
          )
        `);
        const counts = await countCandidates(tx, dataset, cutoff, input.now);
        const paused = input.mode === "enforce" && input.enforcementPaused;
        const processedCount =
          input.mode === "enforce" && !paused
            ? await enforceDataset(tx, dataset, cutoff, input.now, input.batchSize)
            : 0;
        const output: RetentionDatasetResult = {
          dataset,
          cutoff,
          candidateCount: counts.candidateCount,
          protectedCount: counts.candidateCount - counts.eligibleCount,
          processedCount,
          outcome: paused ? "paused" : "completed",
        };
        await recordRun(tx, {
          ...output,
          policyVersion: input.policyVersion,
          mode: input.mode,
          startedAt,
          completedAt: new Date(),
        });
        return output;
      });
      results.push(result);
    } catch {
      const failed: RetentionDatasetResult = {
        dataset,
        cutoff,
        candidateCount: 0,
        protectedCount: 0,
        processedCount: 0,
        outcome: "failed",
      };
      await input.db.transaction((tx) =>
        recordRun(tx, {
          ...failed,
          policyVersion: input.policyVersion,
          mode: input.mode,
          startedAt,
          completedAt: new Date(),
        }),
      );
      results.push(failed);
    }
  }
  return results;
}
