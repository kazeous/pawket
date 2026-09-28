CREATE TABLE "identity_oidc_proof_bindings" (
	"proof_id" uuid PRIMARY KEY NOT NULL,
	"authorization_version" integer NOT NULL,
	"command_digest" text NOT NULL,
	"provider_revision" text NOT NULL,
	"transaction_id" uuid NOT NULL,
	CONSTRAINT "identity_oidc_proof_bindings_version_check" CHECK ("identity_oidc_proof_bindings"."authorization_version" > 0),
	CONSTRAINT "identity_oidc_proof_bindings_digest_check" CHECK ("identity_oidc_proof_bindings"."command_digest" ~ '^hmac-sha256:v1:[A-Za-z0-9_-]{43}$')
);
--> statement-breakpoint
ALTER TABLE "identity_oidc_pending_commands" ADD COLUMN "proof_id" uuid;--> statement-breakpoint
ALTER TABLE "identity_oidc_proof_bindings" ADD CONSTRAINT "identity_oidc_proof_bindings_proof_id_identity_step_up_proofs_id_fk" FOREIGN KEY ("proof_id") REFERENCES "identity_step_up_proofs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_oidc_proof_bindings" ADD CONSTRAINT "identity_oidc_proof_bindings_transaction_id_identity_oidc_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "identity_oidc_transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_oidc_pending_commands" ADD CONSTRAINT "identity_oidc_pending_commands_proof_id_identity_step_up_proofs_id_fk" FOREIGN KEY ("proof_id") REFERENCES "identity_step_up_proofs"("id") ON DELETE restrict ON UPDATE no action;