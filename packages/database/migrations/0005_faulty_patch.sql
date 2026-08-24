CREATE TABLE "identity_email_addresses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"display_email" text NOT NULL,
	"canonical_email" text NOT NULL,
	"status" text NOT NULL,
	"verified_at" timestamp with time zone,
	"verification_provenance" text,
	"replaced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "identity_email_addresses_status_check" CHECK ("identity_email_addresses"."status" in ('pending', 'primary', 'previous')),
	CONSTRAINT "identity_email_addresses_verification_check" CHECK (("identity_email_addresses"."verified_at" is null and "identity_email_addresses"."verification_provenance" is null)
        or ("identity_email_addresses"."verified_at" is not null and "identity_email_addresses"."verification_provenance" in ('password_email_challenge', 'provider_assertion'))),
	CONSTRAINT "identity_email_addresses_replaced_check" CHECK (("identity_email_addresses"."status" = 'previous' and "identity_email_addresses"."replaced_at" is not null)
        or ("identity_email_addresses"."status" <> 'previous' and "identity_email_addresses"."replaced_at" is null))
);
--> statement-breakpoint
ALTER TABLE "identity_verifications" ADD COLUMN "target_email" text;--> statement-breakpoint
ALTER TABLE "identity_email_addresses" ADD CONSTRAINT "identity_email_addresses_user_id_identity_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "identity_users"("id") ON DELETE cascade ON UPDATE restrict;--> statement-breakpoint
CREATE UNIQUE INDEX "identity_email_addresses_canonical_uidx" ON "identity_email_addresses" USING btree ("canonical_email");--> statement-breakpoint
CREATE UNIQUE INDEX "identity_email_addresses_primary_user_uidx" ON "identity_email_addresses" USING btree ("user_id") WHERE "identity_email_addresses"."status" = 'primary';--> statement-breakpoint
CREATE INDEX "identity_email_addresses_user_idx" ON "identity_email_addresses" USING btree ("user_id");
