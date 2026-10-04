ALTER TABLE "identity_oidc_sessions" RENAME COLUMN "totp_status" TO "mfa_status";--> statement-breakpoint
ALTER TABLE "identity_oidc_sessions" RENAME CONSTRAINT "identity_oidc_sessions_totp_status_check" TO "identity_oidc_sessions_mfa_status_check";--> statement-breakpoint
ALTER TABLE "payment_confirmations" RENAME COLUMN "totp_verified_at" TO "mfa_verified_at";--> statement-breakpoint
ALTER TABLE "payments_sepay_account_cutovers" RENAME COLUMN "totp_verified_at" TO "mfa_verified_at";--> statement-breakpoint
ALTER TABLE "identity_step_up_proofs" DROP CONSTRAINT "identity_step_up_proofs_assurance_method_check";--> statement-breakpoint
ALTER TABLE "identity_step_up_proofs" ADD CONSTRAINT "identity_step_up_proofs_assurance_method_check" CHECK ("identity_step_up_proofs"."assurance_method" in ('primary', 'totp', 'mfa', 'recovery'));--> statement-breakpoint
ALTER TABLE "identity_step_up_proofs" DROP CONSTRAINT "identity_step_up_proofs_owner_totp_check";--> statement-breakpoint
ALTER TABLE "identity_step_up_proofs" ADD CONSTRAINT "identity_step_up_proofs_owner_totp_check" CHECK ("identity_step_up_proofs"."action_class" !~ '^owner[.]' or "identity_step_up_proofs"."assurance_method" in ('totp', 'mfa'));
