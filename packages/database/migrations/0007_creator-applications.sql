CREATE TABLE "creator_application_attestations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"revision_id" uuid NOT NULL,
	"type" text NOT NULL,
	"policy_version" text NOT NULL,
	"accepted_at" timestamp with time zone NOT NULL,
	"actor_user_id" text NOT NULL,
	CONSTRAINT "creator_application_attestations_type_check" CHECK ("creator_application_attestations"."type" in ('dob_truthfulness','portfolio_rights','truthful_information','creator_terms','privacy'))
);
--> statement-breakpoint
CREATE TABLE "creator_application_revisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"application_id" uuid NOT NULL,
	"revision_number" integer NOT NULL,
	"artist_display_name" text,
	"short_introduction" text,
	"applicant_email" text,
	"dob_envelope" jsonb,
	"portfolio_urls" jsonb,
	"primary_art_discipline" text,
	"practice_description" text,
	"content_intent" text,
	"proposed_receiving_account_id" text,
	"age_at_submission" integer,
	"age_evaluated_on" text,
	"submitted_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "creator_application_revisions_content_intent_check" CHECK ("creator_application_revisions"."content_intent" is null or "creator_application_revisions"."content_intent" in ('general_audience_only','may_include_age_restricted'))
);
--> statement-breakpoint
CREATE TABLE "creator_applications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"state" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"current_revision_id" uuid,
	"rejected_at" timestamp with time zone,
	"cooldown_until" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "creator_applications_state_check" CHECK ("creator_applications"."state" in ('draft','submitted','under_review','changes_requested','rejected','withdrawn')),
	CONSTRAINT "creator_applications_version_check" CHECK ("creator_applications"."version" > 0),
	CONSTRAINT "creator_applications_cooldown_check" CHECK (("creator_applications"."state" = 'rejected' and "creator_applications"."rejected_at" is not null and "creator_applications"."cooldown_until" is not null) or ("creator_applications"."state" <> 'rejected' and "creator_applications"."rejected_at" is null and "creator_applications"."cooldown_until" is null))
);
--> statement-breakpoint
ALTER TABLE "creator_application_attestations" ADD CONSTRAINT "creator_application_attestations_revision_id_creator_application_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "creator_application_revisions"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "creator_application_attestations" ADD CONSTRAINT "creator_application_attestations_actor_user_id_identity_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "identity_users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "creator_application_revisions" ADD CONSTRAINT "creator_application_revisions_application_id_creator_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "creator_applications"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "creator_applications" ADD CONSTRAINT "creator_applications_user_id_identity_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "identity_users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
CREATE UNIQUE INDEX "creator_application_attestations_revision_type_uidx" ON "creator_application_attestations" USING btree ("revision_id","type");--> statement-breakpoint
CREATE UNIQUE INDEX "creator_application_revisions_number_uidx" ON "creator_application_revisions" USING btree ("application_id","revision_number");--> statement-breakpoint
CREATE INDEX "creator_application_revisions_app_idx" ON "creator_application_revisions" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "creator_applications_user_idx" ON "creator_applications" USING btree ("user_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "creator_applications_one_nonterminal_uidx" ON "creator_applications" USING btree ("user_id") WHERE "creator_applications"."state" in ('draft','submitted','under_review','changes_requested');
