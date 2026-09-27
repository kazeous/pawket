CREATE TABLE "commission_acceptances" (
	"id" uuid PRIMARY KEY NOT NULL,
	"order_id" uuid NOT NULL,
	"actor_user_id" text NOT NULL,
	"actor_session_id" text NOT NULL,
	"role" text NOT NULL,
	"package_revision_id" uuid NOT NULL,
	"quote_revision_id" uuid,
	"policy_revision_id" uuid NOT NULL,
	"request_id" text NOT NULL,
	"accepted_at" timestamp with time zone NOT NULL,
	CONSTRAINT "commission_acceptance_role_check" CHECK ("commission_acceptances"."role" in ('buyer','creator'))
);
--> statement-breakpoint
CREATE TABLE "commission_briefs" (
	"order_id" uuid PRIMARY KEY NOT NULL,
	"text_envelope" jsonb NOT NULL,
	"links_envelope" jsonb NOT NULL,
	"buyer_session_id" text NOT NULL,
	"request_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "commission_briefs_text_check" CHECK (coalesce(
  jsonb_typeof("commission_briefs"."text_envelope") = 'object' and octet_length("commission_briefs"."text_envelope"::text) <= 24000
  and "commission_briefs"."text_envelope"->'version' = '1'::jsonb and "commission_briefs"."text_envelope"->>'algorithm' = 'A256GCM'
  and jsonb_typeof("commission_briefs"."text_envelope"->'keyId') = 'string' and "commission_briefs"."text_envelope"->>'keyId' ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
  and "commission_briefs"."text_envelope"->>'nonce' ~ '^[A-Za-z0-9_-]{16}$'
  and "commission_briefs"."text_envelope"->>'ciphertext' ~ '^[A-Za-z0-9_-]+$'
  and "commission_briefs"."text_envelope"->>'authenticationTag' ~ '^[A-Za-z0-9_-]{22}$'
  and "commission_briefs"."text_envelope" - ARRAY['version','algorithm','keyId','nonce','ciphertext','authenticationTag'] = '{}'::jsonb, false)),
	CONSTRAINT "commission_briefs_links_check" CHECK (coalesce(
  jsonb_typeof("commission_briefs"."links_envelope") = 'object' and octet_length("commission_briefs"."links_envelope"::text) <= 24000
  and "commission_briefs"."links_envelope"->'version' = '1'::jsonb and "commission_briefs"."links_envelope"->>'algorithm' = 'A256GCM'
  and jsonb_typeof("commission_briefs"."links_envelope"->'keyId') = 'string' and "commission_briefs"."links_envelope"->>'keyId' ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
  and "commission_briefs"."links_envelope"->>'nonce' ~ '^[A-Za-z0-9_-]{16}$'
  and "commission_briefs"."links_envelope"->>'ciphertext' ~ '^[A-Za-z0-9_-]+$'
  and "commission_briefs"."links_envelope"->>'authenticationTag' ~ '^[A-Za-z0-9_-]{22}$'
  and "commission_briefs"."links_envelope" - ARRAY['version','algorithm','keyId','nonce','ciphertext','authenticationTag'] = '{}'::jsonb, false))
);
--> statement-breakpoint
CREATE TABLE "commission_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"order_id" uuid NOT NULL,
	"order_version" integer NOT NULL,
	"type" text NOT NULL,
	"actor_user_id" text,
	"actor_session_id" text,
	"reason" text,
	"request_id" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	CONSTRAINT "commission_events_version_check" CHECK ("commission_events"."order_version" > 0),
	CONSTRAINT "commission_events_type_check" CHECK ("commission_events"."type" in ('requested','quoted','awaiting_payment','in_progress','closed'))
);
--> statement-breakpoint
CREATE TABLE "commission_orders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"creator_user_id" text NOT NULL,
	"buyer_user_id" text NOT NULL,
	"package_id" uuid NOT NULL,
	"package_revision_id" uuid NOT NULL,
	"route" text NOT NULL,
	"state" text DEFAULT 'requested' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"amount_vnd" bigint,
	"current_quote_id" uuid,
	"expires_at" timestamp with time zone,
	"accepted_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	"due_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"close_reason" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "commission_orders_actor_check" CHECK ("commission_orders"."creator_user_id" <> "commission_orders"."buyer_user_id"),
	CONSTRAINT "commission_orders_route_check" CHECK ("commission_orders"."route" in ('fixed_immediate','fixed_approval','custom_quote')),
	CONSTRAINT "commission_orders_state_check" CHECK ("commission_orders"."state" in ('requested','quoted','awaiting_payment','in_progress','closed') and "commission_orders"."version" > 0),
	CONSTRAINT "commission_orders_amount_check" CHECK ("commission_orders"."amount_vnd" is null or "commission_orders"."amount_vnd" between 50000 and 50000000),
	CONSTRAINT "commission_orders_payment_state_check" CHECK (("commission_orders"."state" not in ('awaiting_payment','in_progress') or ("commission_orders"."accepted_at" is not null and "commission_orders"."amount_vnd" is not null))
    and ("commission_orders"."state" not in ('requested','quoted') or ("commission_orders"."accepted_at" is null and "commission_orders"."amount_vnd" is null))
    and ("commission_orders"."state" <> 'quoted' or ("commission_orders"."route" = 'custom_quote' and "commission_orders"."current_quote_id" is not null))),
	CONSTRAINT "commission_orders_deadline_check" CHECK (("commission_orders"."state" not in ('requested','quoted','awaiting_payment') or ("commission_orders"."expires_at" is not null and "commission_orders"."expires_at" > "commission_orders"."created_at"))
    and ("commission_orders"."state" <> 'in_progress' or ("commission_orders"."expires_at" is not null and "commission_orders"."confirmed_at" < "commission_orders"."expires_at"))),
	CONSTRAINT "commission_orders_completion_check" CHECK (coalesce(("commission_orders"."state" = 'in_progress' and "commission_orders"."confirmed_at" is not null and "commission_orders"."due_at" > "commission_orders"."confirmed_at")
    or ("commission_orders"."state" <> 'in_progress' and "commission_orders"."confirmed_at" is null and "commission_orders"."due_at" is null), false)),
	CONSTRAINT "commission_orders_closed_check" CHECK (("commission_orders"."state" = 'closed' and "commission_orders"."closed_at" is not null and "commission_orders"."close_reason" is not null
    and "commission_orders"."close_reason" in ('buyer_withdrawn','creator_declined','quote_withdrawn','quote_declined','request_expired','quote_expired','buyer_cancelled','creator_cancelled','payment_expired','security_invalidated','eligibility_invalidated'))
    or ("commission_orders"."state" <> 'closed' and "commission_orders"."closed_at" is null and "commission_orders"."close_reason" is null)),
	CONSTRAINT "commission_orders_time_check" CHECK ("commission_orders"."updated_at" >= "commission_orders"."created_at" and ("commission_orders"."accepted_at" is null or "commission_orders"."accepted_at" between "commission_orders"."created_at" and "commission_orders"."updated_at")
    and ("commission_orders"."confirmed_at" is null or "commission_orders"."confirmed_at" between "commission_orders"."accepted_at" and "commission_orders"."updated_at") and ("commission_orders"."closed_at" is null or "commission_orders"."closed_at" = "commission_orders"."updated_at"))
);
--> statement-breakpoint
CREATE TABLE "commission_package_revisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"package_id" uuid NOT NULL,
	"creator_user_id" text NOT NULL,
	"revision_number" integer NOT NULL,
	"policy_revision_id" uuid NOT NULL,
	"route" text NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"discipline" text NOT NULL,
	"brief_instructions" text NOT NULL,
	"terms" jsonb,
	"showcase_id" uuid,
	"actor_session_id" text NOT NULL,
	"request_id" text NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	CONSTRAINT "commission_package_revision_route_check" CHECK ("commission_package_revisions"."route" in ('fixed_immediate','fixed_approval','custom_quote')),
	CONSTRAINT "commission_package_revision_text_check" CHECK (char_length("commission_package_revisions"."title") between 1 and 100 and char_length("commission_package_revisions"."description") <= 2000 and char_length("commission_package_revisions"."brief_instructions") <= 2000 and "commission_package_revisions"."revision_number" > 0),
	CONSTRAINT "commission_package_revision_terms_check" CHECK (("commission_package_revisions"."route" = 'custom_quote' and "commission_package_revisions"."terms" is null) or ("commission_package_revisions"."route" <> 'custom_quote' and "commission_package_revisions"."terms" is not null and jsonb_typeof("commission_package_revisions"."terms") = 'object' and octet_length("commission_package_revisions"."terms"::text) <= 48000))
);
--> statement-breakpoint
CREATE TABLE "commission_packages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"creator_user_id" text NOT NULL,
	"page_id" uuid NOT NULL,
	"draft" jsonb NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"published_revision_id" uuid,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "commission_packages_state_check" CHECK ("commission_packages"."state" in ('draft','open','paused','archived') and "commission_packages"."version" > 0),
	CONSTRAINT "commission_packages_draft_check" CHECK (jsonb_typeof("commission_packages"."draft") = 'object' and octet_length("commission_packages"."draft"::text) <= 65536),
	CONSTRAINT "commission_packages_publication_check" CHECK (("commission_packages"."state" not in ('open','paused') or "commission_packages"."published_revision_id" is not null) and ("commission_packages"."state" <> 'draft' or "commission_packages"."published_revision_id" is null)),
	CONSTRAINT "commission_packages_time_check" CHECK ("commission_packages"."updated_at" >= "commission_packages"."created_at")
);
--> statement-breakpoint
CREATE TABLE "commission_policy_current" (
	"singleton" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"revision_id" uuid NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "commission_policy_singleton_check" CHECK ("commission_policy_current"."singleton" = true)
);
--> statement-breakpoint
CREATE TABLE "commission_policy_revisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"revision_number" integer NOT NULL,
	"technical_version" text DEFAULT 'commission-v1' NOT NULL,
	"minimum_vnd" bigint DEFAULT 50000 NOT NULL,
	"maximum_vnd" bigint DEFAULT 50000000 NOT NULL,
	"document" text,
	"approval_kind" text DEFAULT 'technical_only' NOT NULL,
	"actor_user_id" text,
	"actor_session_id" text,
	"source" text NOT NULL,
	"checksum" text NOT NULL,
	"effective_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "commission_policy_version_check" CHECK ("commission_policy_revisions"."revision_number" > 0 and "commission_policy_revisions"."technical_version" = 'commission-v1'),
	CONSTRAINT "commission_policy_amount_check" CHECK ("commission_policy_revisions"."minimum_vnd" = 50000 and "commission_policy_revisions"."maximum_vnd" = 50000000),
	CONSTRAINT "commission_policy_approval_check" CHECK (coalesce(
    ("commission_policy_revisions"."approval_kind" = 'technical_only' and "commission_policy_revisions"."document" is null and "commission_policy_revisions"."actor_user_id" is null and "commission_policy_revisions"."actor_session_id" is null)
    or ("commission_policy_revisions"."approval_kind" = 'synthetic' and char_length("commission_policy_revisions"."document") between 1 and 16000 and "commission_policy_revisions"."actor_user_id" is null and "commission_policy_revisions"."actor_session_id" is null)
    or ("commission_policy_revisions"."approval_kind" = 'owner_reviewed' and char_length("commission_policy_revisions"."document") between 1 and 16000 and "commission_policy_revisions"."actor_user_id" is not null and "commission_policy_revisions"."actor_session_id" is not null), false)),
	CONSTRAINT "commission_policy_checksum_check" CHECK ("commission_policy_revisions"."checksum" ~ '^sha256:[a-f0-9]{64}$' and char_length("commission_policy_revisions"."source") between 1 and 200)
);
--> statement-breakpoint
CREATE TABLE "commission_quote_revisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"order_id" uuid NOT NULL,
	"revision_number" integer NOT NULL,
	"policy_revision_id" uuid NOT NULL,
	"amount_vnd" bigint NOT NULL,
	"turnaround_days" integer NOT NULL,
	"revision_allowance" integer NOT NULL,
	"review_window_days" integer NOT NULL,
	"scope_envelope" jsonb NOT NULL,
	"deliverables_envelope" jsonb NOT NULL,
	"usage_rights_envelope" jsonb NOT NULL,
	"artist_terms_envelope" jsonb NOT NULL,
	"actor_session_id" text NOT NULL,
	"request_id" text NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "commission_quote_time_check" CHECK ("commission_quote_revisions"."revision_number" > 0 and "commission_quote_revisions"."expires_at" >= "commission_quote_revisions"."issued_at" + interval '1 hour' and "commission_quote_revisions"."expires_at" <= "commission_quote_revisions"."issued_at" + interval '14 days'),
	CONSTRAINT "commission_quote_amount_check" CHECK ("commission_quote_revisions"."amount_vnd" between 50000 and 50000000),
	CONSTRAINT "commission_quote_terms_check" CHECK ("commission_quote_revisions"."turnaround_days" between 1 and 90 and "commission_quote_revisions"."revision_allowance" between 0 and 10 and "commission_quote_revisions"."review_window_days" between 3 and 14),
	CONSTRAINT "commission_quote_scope_check" CHECK (coalesce(
  jsonb_typeof("commission_quote_revisions"."scope_envelope") = 'object' and octet_length("commission_quote_revisions"."scope_envelope"::text) <= 24000
  and "commission_quote_revisions"."scope_envelope"->'version' = '1'::jsonb and "commission_quote_revisions"."scope_envelope"->>'algorithm' = 'A256GCM'
  and jsonb_typeof("commission_quote_revisions"."scope_envelope"->'keyId') = 'string' and "commission_quote_revisions"."scope_envelope"->>'keyId' ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
  and "commission_quote_revisions"."scope_envelope"->>'nonce' ~ '^[A-Za-z0-9_-]{16}$'
  and "commission_quote_revisions"."scope_envelope"->>'ciphertext' ~ '^[A-Za-z0-9_-]+$'
  and "commission_quote_revisions"."scope_envelope"->>'authenticationTag' ~ '^[A-Za-z0-9_-]{22}$'
  and "commission_quote_revisions"."scope_envelope" - ARRAY['version','algorithm','keyId','nonce','ciphertext','authenticationTag'] = '{}'::jsonb, false)),
	CONSTRAINT "commission_quote_deliverables_check" CHECK (coalesce(
  jsonb_typeof("commission_quote_revisions"."deliverables_envelope") = 'object' and octet_length("commission_quote_revisions"."deliverables_envelope"::text) <= 24000
  and "commission_quote_revisions"."deliverables_envelope"->'version' = '1'::jsonb and "commission_quote_revisions"."deliverables_envelope"->>'algorithm' = 'A256GCM'
  and jsonb_typeof("commission_quote_revisions"."deliverables_envelope"->'keyId') = 'string' and "commission_quote_revisions"."deliverables_envelope"->>'keyId' ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
  and "commission_quote_revisions"."deliverables_envelope"->>'nonce' ~ '^[A-Za-z0-9_-]{16}$'
  and "commission_quote_revisions"."deliverables_envelope"->>'ciphertext' ~ '^[A-Za-z0-9_-]+$'
  and "commission_quote_revisions"."deliverables_envelope"->>'authenticationTag' ~ '^[A-Za-z0-9_-]{22}$'
  and "commission_quote_revisions"."deliverables_envelope" - ARRAY['version','algorithm','keyId','nonce','ciphertext','authenticationTag'] = '{}'::jsonb, false)),
	CONSTRAINT "commission_quote_rights_check" CHECK (coalesce(
  jsonb_typeof("commission_quote_revisions"."usage_rights_envelope") = 'object' and octet_length("commission_quote_revisions"."usage_rights_envelope"::text) <= 24000
  and "commission_quote_revisions"."usage_rights_envelope"->'version' = '1'::jsonb and "commission_quote_revisions"."usage_rights_envelope"->>'algorithm' = 'A256GCM'
  and jsonb_typeof("commission_quote_revisions"."usage_rights_envelope"->'keyId') = 'string' and "commission_quote_revisions"."usage_rights_envelope"->>'keyId' ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
  and "commission_quote_revisions"."usage_rights_envelope"->>'nonce' ~ '^[A-Za-z0-9_-]{16}$'
  and "commission_quote_revisions"."usage_rights_envelope"->>'ciphertext' ~ '^[A-Za-z0-9_-]+$'
  and "commission_quote_revisions"."usage_rights_envelope"->>'authenticationTag' ~ '^[A-Za-z0-9_-]{22}$'
  and "commission_quote_revisions"."usage_rights_envelope" - ARRAY['version','algorithm','keyId','nonce','ciphertext','authenticationTag'] = '{}'::jsonb, false)),
	CONSTRAINT "commission_quote_artist_terms_check" CHECK (coalesce(
  jsonb_typeof("commission_quote_revisions"."artist_terms_envelope") = 'object' and octet_length("commission_quote_revisions"."artist_terms_envelope"::text) <= 24000
  and "commission_quote_revisions"."artist_terms_envelope"->'version' = '1'::jsonb and "commission_quote_revisions"."artist_terms_envelope"->>'algorithm' = 'A256GCM'
  and jsonb_typeof("commission_quote_revisions"."artist_terms_envelope"->'keyId') = 'string' and "commission_quote_revisions"."artist_terms_envelope"->>'keyId' ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
  and "commission_quote_revisions"."artist_terms_envelope"->>'nonce' ~ '^[A-Za-z0-9_-]{16}$'
  and "commission_quote_revisions"."artist_terms_envelope"->>'ciphertext' ~ '^[A-Za-z0-9_-]+$'
  and "commission_quote_revisions"."artist_terms_envelope"->>'authenticationTag' ~ '^[A-Za-z0-9_-]{22}$'
  and "commission_quote_revisions"."artist_terms_envelope" - ARRAY['version','algorithm','keyId','nonce','ciphertext','authenticationTag'] = '{}'::jsonb, false))
);
--> statement-breakpoint
CREATE TABLE "commission_reservations" (
	"order_id" uuid PRIMARY KEY NOT NULL,
	"creator_user_id" text NOT NULL,
	"state" text DEFAULT 'reserved' NOT NULL,
	"reserved_at" timestamp with time zone NOT NULL,
	"occupied_at" timestamp with time zone,
	"released_at" timestamp with time zone,
	CONSTRAINT "commission_reservations_state_check" CHECK (("commission_reservations"."state" = 'reserved' and "commission_reservations"."occupied_at" is null and "commission_reservations"."released_at" is null)
    or ("commission_reservations"."state" = 'occupied' and "commission_reservations"."occupied_at" is not null and "commission_reservations"."occupied_at" >= "commission_reservations"."reserved_at" and "commission_reservations"."released_at" is null)
    or ("commission_reservations"."state" = 'released' and "commission_reservations"."occupied_at" is null and "commission_reservations"."released_at" is not null and "commission_reservations"."released_at" >= "commission_reservations"."reserved_at"))
);
--> statement-breakpoint
CREATE TABLE "commission_terms_snapshots" (
	"order_id" uuid PRIMARY KEY NOT NULL,
	"package_revision_id" uuid NOT NULL,
	"quote_revision_id" uuid,
	"policy_revision_id" uuid NOT NULL,
	"amount_vnd" bigint NOT NULL,
	"turnaround_days" integer NOT NULL,
	"revision_allowance" integer NOT NULL,
	"review_window_days" integer NOT NULL,
	"scope_envelope" jsonb NOT NULL,
	"deliverables_envelope" jsonb NOT NULL,
	"usage_rights_envelope" jsonb NOT NULL,
	"artist_terms_envelope" jsonb NOT NULL,
	"buyer_accepted_at" timestamp with time zone NOT NULL,
	"creator_accepted_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "commission_snapshot_time_check" CHECK ("commission_terms_snapshots"."buyer_accepted_at" <= "commission_terms_snapshots"."created_at" and "commission_terms_snapshots"."creator_accepted_at" <= "commission_terms_snapshots"."created_at"),
	CONSTRAINT "commission_snapshot_amount_check" CHECK ("commission_terms_snapshots"."amount_vnd" between 50000 and 50000000),
	CONSTRAINT "commission_snapshot_terms_check" CHECK ("commission_terms_snapshots"."turnaround_days" between 1 and 90 and "commission_terms_snapshots"."revision_allowance" between 0 and 10 and "commission_terms_snapshots"."review_window_days" between 3 and 14),
	CONSTRAINT "commission_snapshot_scope_check" CHECK (coalesce(
  jsonb_typeof("commission_terms_snapshots"."scope_envelope") = 'object' and octet_length("commission_terms_snapshots"."scope_envelope"::text) <= 24000
  and "commission_terms_snapshots"."scope_envelope"->'version' = '1'::jsonb and "commission_terms_snapshots"."scope_envelope"->>'algorithm' = 'A256GCM'
  and jsonb_typeof("commission_terms_snapshots"."scope_envelope"->'keyId') = 'string' and "commission_terms_snapshots"."scope_envelope"->>'keyId' ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
  and "commission_terms_snapshots"."scope_envelope"->>'nonce' ~ '^[A-Za-z0-9_-]{16}$'
  and "commission_terms_snapshots"."scope_envelope"->>'ciphertext' ~ '^[A-Za-z0-9_-]+$'
  and "commission_terms_snapshots"."scope_envelope"->>'authenticationTag' ~ '^[A-Za-z0-9_-]{22}$'
  and "commission_terms_snapshots"."scope_envelope" - ARRAY['version','algorithm','keyId','nonce','ciphertext','authenticationTag'] = '{}'::jsonb, false)),
	CONSTRAINT "commission_snapshot_deliverables_check" CHECK (coalesce(
  jsonb_typeof("commission_terms_snapshots"."deliverables_envelope") = 'object' and octet_length("commission_terms_snapshots"."deliverables_envelope"::text) <= 24000
  and "commission_terms_snapshots"."deliverables_envelope"->'version' = '1'::jsonb and "commission_terms_snapshots"."deliverables_envelope"->>'algorithm' = 'A256GCM'
  and jsonb_typeof("commission_terms_snapshots"."deliverables_envelope"->'keyId') = 'string' and "commission_terms_snapshots"."deliverables_envelope"->>'keyId' ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
  and "commission_terms_snapshots"."deliverables_envelope"->>'nonce' ~ '^[A-Za-z0-9_-]{16}$'
  and "commission_terms_snapshots"."deliverables_envelope"->>'ciphertext' ~ '^[A-Za-z0-9_-]+$'
  and "commission_terms_snapshots"."deliverables_envelope"->>'authenticationTag' ~ '^[A-Za-z0-9_-]{22}$'
  and "commission_terms_snapshots"."deliverables_envelope" - ARRAY['version','algorithm','keyId','nonce','ciphertext','authenticationTag'] = '{}'::jsonb, false)),
	CONSTRAINT "commission_snapshot_rights_check" CHECK (coalesce(
  jsonb_typeof("commission_terms_snapshots"."usage_rights_envelope") = 'object' and octet_length("commission_terms_snapshots"."usage_rights_envelope"::text) <= 24000
  and "commission_terms_snapshots"."usage_rights_envelope"->'version' = '1'::jsonb and "commission_terms_snapshots"."usage_rights_envelope"->>'algorithm' = 'A256GCM'
  and jsonb_typeof("commission_terms_snapshots"."usage_rights_envelope"->'keyId') = 'string' and "commission_terms_snapshots"."usage_rights_envelope"->>'keyId' ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
  and "commission_terms_snapshots"."usage_rights_envelope"->>'nonce' ~ '^[A-Za-z0-9_-]{16}$'
  and "commission_terms_snapshots"."usage_rights_envelope"->>'ciphertext' ~ '^[A-Za-z0-9_-]+$'
  and "commission_terms_snapshots"."usage_rights_envelope"->>'authenticationTag' ~ '^[A-Za-z0-9_-]{22}$'
  and "commission_terms_snapshots"."usage_rights_envelope" - ARRAY['version','algorithm','keyId','nonce','ciphertext','authenticationTag'] = '{}'::jsonb, false)),
	CONSTRAINT "commission_snapshot_artist_terms_check" CHECK (coalesce(
  jsonb_typeof("commission_terms_snapshots"."artist_terms_envelope") = 'object' and octet_length("commission_terms_snapshots"."artist_terms_envelope"::text) <= 24000
  and "commission_terms_snapshots"."artist_terms_envelope"->'version' = '1'::jsonb and "commission_terms_snapshots"."artist_terms_envelope"->>'algorithm' = 'A256GCM'
  and jsonb_typeof("commission_terms_snapshots"."artist_terms_envelope"->'keyId') = 'string' and "commission_terms_snapshots"."artist_terms_envelope"->>'keyId' ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
  and "commission_terms_snapshots"."artist_terms_envelope"->>'nonce' ~ '^[A-Za-z0-9_-]{16}$'
  and "commission_terms_snapshots"."artist_terms_envelope"->>'ciphertext' ~ '^[A-Za-z0-9_-]+$'
  and "commission_terms_snapshots"."artist_terms_envelope"->>'authenticationTag' ~ '^[A-Za-z0-9_-]{22}$'
  and "commission_terms_snapshots"."artist_terms_envelope" - ARRAY['version','algorithm','keyId','nonce','ciphertext','authenticationTag'] = '{}'::jsonb, false))
);
--> statement-breakpoint
CREATE TABLE "creator_commission_settings" (
	"creator_user_id" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"capacity_limit" integer DEFAULT 3 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "creator_commission_capacity_check" CHECK ("creator_commission_settings"."capacity_limit" between 1 and 20 and "creator_commission_settings"."version" > 0),
	CONSTRAINT "creator_commission_settings_time_check" CHECK ("creator_commission_settings"."updated_at" >= "creator_commission_settings"."created_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "commission_acceptance_role_uidx" ON "commission_acceptances" USING btree ("order_id","role");--> statement-breakpoint
CREATE UNIQUE INDEX "commission_events_version_uidx" ON "commission_events" USING btree ("order_id","order_version");--> statement-breakpoint
CREATE UNIQUE INDEX "commission_order_payment_binding_uidx" ON "commission_orders" USING btree ("id","creator_user_id","amount_vnd");--> statement-breakpoint
CREATE UNIQUE INDEX "commission_order_actor_binding_uidx" ON "commission_orders" USING btree ("id","creator_user_id","buyer_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "commission_package_revision_number_uidx" ON "commission_package_revisions" USING btree ("package_id","revision_number");--> statement-breakpoint
CREATE UNIQUE INDEX "commission_package_revision_binding_uidx" ON "commission_package_revisions" USING btree ("id","package_id","creator_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "commission_packages_owner_uidx" ON "commission_packages" USING btree ("id","creator_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "commission_policy_number_uidx" ON "commission_policy_revisions" USING btree ("revision_number");--> statement-breakpoint
CREATE UNIQUE INDEX "commission_quote_revision_number_uidx" ON "commission_quote_revisions" USING btree ("order_id","revision_number");--> statement-breakpoint
CREATE UNIQUE INDEX "commission_quote_order_binding_uidx" ON "commission_quote_revisions" USING btree ("id","order_id");--> statement-breakpoint
ALTER TABLE "commission_acceptances" ADD CONSTRAINT "commission_acceptances_order_id_commission_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "commission_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_acceptances" ADD CONSTRAINT "commission_acceptances_actor_user_id_identity_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "identity_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_acceptances" ADD CONSTRAINT "commission_acceptances_package_revision_id_commission_package_revisions_id_fk" FOREIGN KEY ("package_revision_id") REFERENCES "commission_package_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_acceptances" ADD CONSTRAINT "commission_acceptances_quote_revision_id_commission_quote_revisions_id_fk" FOREIGN KEY ("quote_revision_id") REFERENCES "commission_quote_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_acceptances" ADD CONSTRAINT "commission_acceptances_policy_revision_id_commission_policy_revisions_id_fk" FOREIGN KEY ("policy_revision_id") REFERENCES "commission_policy_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_briefs" ADD CONSTRAINT "commission_briefs_order_id_commission_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "commission_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_events" ADD CONSTRAINT "commission_events_order_id_commission_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "commission_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_orders" ADD CONSTRAINT "commission_orders_creator_user_id_identity_users_id_fk" FOREIGN KEY ("creator_user_id") REFERENCES "identity_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_orders" ADD CONSTRAINT "commission_orders_buyer_user_id_identity_users_id_fk" FOREIGN KEY ("buyer_user_id") REFERENCES "identity_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_orders" ADD CONSTRAINT "commission_orders_current_quote_id_commission_quote_revisions_id_fk" FOREIGN KEY ("current_quote_id") REFERENCES "commission_quote_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_orders" ADD CONSTRAINT "commission_order_package_binding_fk" FOREIGN KEY ("package_revision_id","package_id","creator_user_id") REFERENCES "commission_package_revisions"("id","package_id","creator_user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_package_revisions" ADD CONSTRAINT "commission_package_revisions_policy_revision_id_commission_policy_revisions_id_fk" FOREIGN KEY ("policy_revision_id") REFERENCES "commission_policy_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_package_revisions" ADD CONSTRAINT "commission_package_revision_owner_fk" FOREIGN KEY ("package_id","creator_user_id") REFERENCES "commission_packages"("id","creator_user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_packages" ADD CONSTRAINT "commission_packages_creator_user_id_identity_users_id_fk" FOREIGN KEY ("creator_user_id") REFERENCES "identity_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_packages" ADD CONSTRAINT "commission_packages_page_id_creator_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "creator_pages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_packages" ADD CONSTRAINT "commission_packages_published_revision_id_commission_package_revisions_id_fk" FOREIGN KEY ("published_revision_id") REFERENCES "commission_package_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_policy_current" ADD CONSTRAINT "commission_policy_current_revision_id_commission_policy_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "commission_policy_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_policy_revisions" ADD CONSTRAINT "commission_policy_revisions_actor_user_id_identity_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "identity_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_quote_revisions" ADD CONSTRAINT "commission_quote_revisions_order_id_commission_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "commission_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_quote_revisions" ADD CONSTRAINT "commission_quote_revisions_policy_revision_id_commission_policy_revisions_id_fk" FOREIGN KEY ("policy_revision_id") REFERENCES "commission_policy_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_reservations" ADD CONSTRAINT "commission_reservations_order_id_commission_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "commission_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_reservations" ADD CONSTRAINT "commission_reservations_creator_user_id_identity_users_id_fk" FOREIGN KEY ("creator_user_id") REFERENCES "identity_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_terms_snapshots" ADD CONSTRAINT "commission_terms_snapshots_order_id_commission_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "commission_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_terms_snapshots" ADD CONSTRAINT "commission_terms_snapshots_package_revision_id_commission_package_revisions_id_fk" FOREIGN KEY ("package_revision_id") REFERENCES "commission_package_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_terms_snapshots" ADD CONSTRAINT "commission_terms_snapshots_quote_revision_id_commission_quote_revisions_id_fk" FOREIGN KEY ("quote_revision_id") REFERENCES "commission_quote_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_terms_snapshots" ADD CONSTRAINT "commission_terms_snapshots_policy_revision_id_commission_policy_revisions_id_fk" FOREIGN KEY ("policy_revision_id") REFERENCES "commission_policy_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creator_commission_settings" ADD CONSTRAINT "creator_commission_settings_creator_user_id_identity_users_id_fk" FOREIGN KEY ("creator_user_id") REFERENCES "identity_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "commission_orders_buyer_idx" ON "commission_orders" USING btree ("buyer_user_id","created_at","id");--> statement-breakpoint
CREATE INDEX "commission_orders_creator_idx" ON "commission_orders" USING btree ("creator_user_id","state","created_at","id");--> statement-breakpoint
CREATE INDEX "commission_orders_expiry_idx" ON "commission_orders" USING btree ("expires_at","id") WHERE "commission_orders"."state" in ('requested','quoted','awaiting_payment');--> statement-breakpoint
CREATE INDEX "commission_packages_creator_idx" ON "commission_packages" USING btree ("creator_user_id","created_at","id");--> statement-breakpoint
CREATE INDEX "commission_reservations_capacity_idx" ON "commission_reservations" USING btree ("creator_user_id","state");
--> statement-breakpoint
-- Technical limits are approved; a live cancellation/refund policy is not.
INSERT INTO commission_policy_revisions
  (id, revision_number, technical_version, minimum_vnd, maximum_vnd, document, approval_kind, source, checksum, effective_at, created_at)
VALUES ('00000000-0000-4000-8000-000000000006', 1, 'commission-v1', 50000, 50000000, NULL, 'technical_only',
  'increment-6-owner-approved-2026-09-25', 'sha256:cd2aa50ba001902be6ba84ebd587afd67c9bf7a6820f4a5d7695ae78c5c48119',
  '2026-09-25T00:00:00Z', '2026-09-25T00:00:00Z');
--> statement-breakpoint
INSERT INTO commission_policy_current (singleton, revision_id, updated_at)
VALUES (true, '00000000-0000-4000-8000-000000000006', '2026-09-25T00:00:00Z');
--> statement-breakpoint
CREATE FUNCTION commission_reject_history_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  RAISE EXCEPTION 'Commission history is immutable' USING ERRCODE = '23514';
END;
$$;
--> statement-breakpoint
DO $$
DECLARE target text;
BEGIN
  FOREACH target IN ARRAY ARRAY['commission_policy_revisions','commission_package_revisions','commission_briefs',
    'commission_quote_revisions','commission_terms_snapshots','commission_acceptances','commission_events'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION commission_reject_history_mutation()', target || '_immutable', target);
  END LOOP;
END;
$$;
--> statement-breakpoint
-- Every commission writer enters this fence before taking rows. Raw writes that
-- already took a row must fail/retry instead of reversing the application order.
CREATE FUNCTION commission_try_creator_fence(creator_id text) RETURNS void
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtextextended('commissions:creator:' || creator_id, 0)) THEN
    RAISE EXCEPTION 'Commission creator is busy; retry transaction' USING ERRCODE = '40001';
  END IF;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION commission_public_terms_valid(terms jsonb, policy_id uuid) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path FROM CURRENT AS $$
DECLARE field text; amount numeric;
BEGIN
  IF terms IS NULL OR jsonb_typeof(terms) <> 'object'
    OR NOT terms ?& ARRAY['amountVnd','turnaroundDays','revisionAllowance','reviewWindowDays','scope','deliverables','usageRights','artistTerms','policyRevisionId']
    OR terms - ARRAY['amountVnd','turnaroundDays','revisionAllowance','reviewWindowDays','scope','deliverables','usageRights','artistTerms','policyRevisionId'] <> '{}'::jsonb
    OR jsonb_typeof(terms->'policyRevisionId') <> 'string' OR terms->>'policyRevisionId' <> policy_id::text THEN RETURN false; END IF;
  FOREACH field IN ARRAY ARRAY['amountVnd','turnaroundDays','revisionAllowance','reviewWindowDays'] LOOP
    IF jsonb_typeof(terms->field) <> 'number' THEN RETURN false; END IF;
    amount := (terms->>field)::numeric;
    IF amount <> trunc(amount) THEN RETURN false; END IF;
  END LOOP;
  IF (terms->>'amountVnd')::numeric NOT BETWEEN 50000 AND 50000000
    OR (terms->>'turnaroundDays')::numeric NOT BETWEEN 1 AND 90
    OR (terms->>'revisionAllowance')::numeric NOT BETWEEN 0 AND 10
    OR (terms->>'reviewWindowDays')::numeric NOT BETWEEN 3 AND 14 THEN RETURN false; END IF;
  FOREACH field IN ARRAY ARRAY['scope','deliverables','usageRights','artistTerms'] LOOP
    IF jsonb_typeof(terms->field) <> 'string' OR char_length(terms->>field) NOT BETWEEN 1 AND 2000
      OR octet_length((terms->field)::text) > 16384 OR btrim(terms->>field) = ''
      OR (terms->>field) ~ '[<>]' THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION commission_guard_catalog() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE package commission_packages%ROWTYPE; revision commission_package_revisions%ROWTYPE; total integer;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Commission catalog cannot delete history' USING ERRCODE = '23514'; END IF;
  PERFORM commission_try_creator_fence(NEW.creator_user_id);
  IF TG_TABLE_NAME = 'creator_commission_settings' THEN
    IF TG_OP = 'UPDATE' AND (NEW.creator_user_id <> OLD.creator_user_id OR NEW.created_at <> OLD.created_at OR NEW.version <> OLD.version + 1) THEN
      RAISE EXCEPTION 'Invalid commission settings revision' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME = 'commission_package_revisions' THEN
    SELECT * INTO package FROM commission_packages WHERE id = NEW.package_id;
    IF NOT FOUND OR package.creator_user_id <> NEW.creator_user_id OR package.state = 'archived'
      OR (NEW.route <> 'custom_quote' AND NOT commission_public_terms_valid(NEW.terms, NEW.policy_revision_id)) THEN
      RAISE EXCEPTION 'Invalid commission package revision' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM creator_pages WHERE id = NEW.page_id AND user_id = NEW.creator_user_id) THEN
    RAISE EXCEPTION 'Commission package page owner mismatch' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'draft' OR NEW.version <> 1 OR NEW.published_revision_id IS NOT NULL THEN
      RAISE EXCEPTION 'Commission package must start as draft' USING ERRCODE = '23514';
    END IF;
    SELECT count(*) INTO total FROM commission_packages WHERE creator_user_id = NEW.creator_user_id AND state <> 'archived';
    IF total >= 12 THEN RAISE EXCEPTION 'Commission package limit reached' USING ERRCODE = '23514'; END IF;
  ELSE
    IF NEW.id <> OLD.id OR NEW.creator_user_id <> OLD.creator_user_id OR NEW.page_id <> OLD.page_id
      OR NEW.created_at <> OLD.created_at OR NEW.version <> OLD.version + 1 OR NEW.updated_at < OLD.updated_at
      OR OLD.state = 'archived' OR (OLD.state <> 'draft' AND NEW.state = 'draft') THEN
      RAISE EXCEPTION 'Invalid commission package transition' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.published_revision_id IS NOT NULL THEN
    SELECT * INTO revision FROM commission_package_revisions WHERE id = NEW.published_revision_id;
    IF NOT FOUND OR revision.package_id <> NEW.id OR revision.creator_user_id <> NEW.creator_user_id THEN
      RAISE EXCEPTION 'Commission publication owner mismatch' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER creator_commission_settings_guard BEFORE INSERT OR UPDATE OR DELETE ON creator_commission_settings
FOR EACH ROW EXECUTE FUNCTION commission_guard_catalog();
--> statement-breakpoint
CREATE TRIGGER commission_packages_guard BEFORE INSERT OR UPDATE OR DELETE ON commission_packages
FOR EACH ROW EXECUTE FUNCTION commission_guard_catalog();
--> statement-breakpoint
CREATE TRIGGER commission_package_revisions_guard BEFORE INSERT ON commission_package_revisions
FOR EACH ROW EXECUTE FUNCTION commission_guard_catalog();
--> statement-breakpoint
CREATE FUNCTION commission_guard_order() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE revision commission_package_revisions%ROWTYPE; total integer; allowed boolean := false;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Commission orders cannot be deleted' USING ERRCODE = '23514'; END IF;
  PERFORM commission_try_creator_fence(NEW.creator_user_id);
  SELECT * INTO revision FROM commission_package_revisions WHERE id = NEW.package_revision_id;
  IF NOT FOUND OR revision.route <> NEW.route OR revision.creator_user_id <> NEW.creator_user_id THEN
    RAISE EXCEPTION 'Commission package contract mismatch' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.version <> 1 OR NEW.state NOT IN ('requested','awaiting_payment')
      OR (NEW.route = 'fixed_immediate' AND NEW.state <> 'awaiting_payment')
      OR (NEW.route <> 'fixed_immediate' AND NEW.state <> 'requested') THEN
      RAISE EXCEPTION 'Invalid initial commission state' USING ERRCODE = '23514';
    END IF;
    SELECT count(*) INTO total FROM commission_orders WHERE creator_user_id = NEW.creator_user_id AND buyer_user_id = NEW.buyer_user_id AND state <> 'closed';
    IF total >= 3 THEN RAISE EXCEPTION 'Commission request limit reached' USING ERRCODE = '23514'; END IF;
  ELSE
    IF NEW.id <> OLD.id OR NEW.creator_user_id <> OLD.creator_user_id OR NEW.buyer_user_id <> OLD.buyer_user_id
      OR NEW.package_id <> OLD.package_id OR NEW.package_revision_id <> OLD.package_revision_id OR NEW.route <> OLD.route
      OR NEW.created_at <> OLD.created_at OR NEW.version <> OLD.version + 1 OR NEW.updated_at < OLD.updated_at THEN
      RAISE EXCEPTION 'Commission identity/version is immutable' USING ERRCODE = '23514';
    END IF;
    IF OLD.state = 'requested' THEN
      allowed := NEW.state IN ('quoted','awaiting_payment') OR (NEW.state = 'closed' AND NEW.close_reason IN ('buyer_withdrawn','creator_declined','request_expired','security_invalidated','eligibility_invalidated'));
    ELSIF OLD.state = 'quoted' THEN
      allowed := NEW.state IN ('quoted','awaiting_payment') OR (NEW.state = 'closed' AND NEW.close_reason IN ('buyer_withdrawn','quote_withdrawn','quote_declined','quote_expired','security_invalidated','eligibility_invalidated'));
    ELSIF OLD.state = 'awaiting_payment' THEN
      allowed := NEW.state = 'in_progress' OR (NEW.state = 'closed' AND NEW.close_reason IN ('buyer_cancelled','creator_cancelled','payment_expired','security_invalidated','eligibility_invalidated'));
    END IF;
    IF NOT coalesce(allowed, false) THEN RAISE EXCEPTION 'Forbidden commission transition' USING ERRCODE = '23514'; END IF;
    IF OLD.accepted_at IS NOT NULL AND (NEW.amount_vnd IS DISTINCT FROM OLD.amount_vnd OR NEW.accepted_at IS DISTINCT FROM OLD.accepted_at
      OR NEW.current_quote_id IS DISTINCT FROM OLD.current_quote_id OR NEW.expires_at IS DISTINCT FROM OLD.expires_at) THEN
      RAISE EXCEPTION 'Accepted commission facts are immutable' USING ERRCODE = '23514';
    END IF;
    IF OLD.expires_at <= NEW.updated_at AND NEW.state <> 'closed' THEN
      RAISE EXCEPTION 'Expired commission cannot advance' USING ERRCODE = '23514';
    END IF;
    IF NEW.state = 'quoted' AND NEW.current_quote_id IS NOT DISTINCT FROM OLD.current_quote_id THEN
      RAISE EXCEPTION 'Quote replacement requires a new revision' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER commission_orders_guard BEFORE INSERT OR UPDATE OR DELETE ON commission_orders
FOR EACH ROW EXECUTE FUNCTION commission_guard_order();
--> statement-breakpoint
CREATE FUNCTION commission_guard_reservation() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE subject commission_orders%ROWTYPE; capacity integer; used integer;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Commission reservation history is required' USING ERRCODE = '23514'; END IF;
  PERFORM commission_try_creator_fence(NEW.creator_user_id);
  SELECT * INTO subject FROM commission_orders WHERE id = NEW.order_id;
  IF NOT FOUND OR subject.creator_user_id <> NEW.creator_user_id THEN RAISE EXCEPTION 'Reservation owner mismatch' USING ERRCODE = '23514'; END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT capacity_limit INTO capacity FROM creator_commission_settings WHERE creator_user_id = NEW.creator_user_id;
    SELECT count(*) INTO used FROM commission_reservations WHERE creator_user_id = NEW.creator_user_id AND state IN ('reserved','occupied');
    IF capacity IS NULL OR used >= capacity OR NEW.state <> 'reserved' THEN RAISE EXCEPTION 'Commission capacity unavailable' USING ERRCODE = '23514'; END IF;
  ELSE
    IF NEW.order_id <> OLD.order_id OR NEW.creator_user_id <> OLD.creator_user_id OR NEW.reserved_at <> OLD.reserved_at
      OR OLD.state <> 'reserved' OR NEW.state NOT IN ('occupied','released') THEN
      RAISE EXCEPTION 'Forbidden reservation transition' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER commission_reservations_guard BEFORE INSERT OR UPDATE OR DELETE ON commission_reservations
FOR EACH ROW EXECUTE FUNCTION commission_guard_reservation();
--> statement-breakpoint
CREATE FUNCTION commission_check_order_graph() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE target_id uuid; subject commission_orders%ROWTYPE; brief commission_briefs%ROWTYPE;
  snapshot commission_terms_snapshots%ROWTYPE; quote commission_quote_revisions%ROWTYPE;
  reservation commission_reservations%ROWTYPE; package commission_package_revisions%ROWTYPE;
  buyer commission_acceptances%ROWTYPE; creator commission_acceptances%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME = 'commission_orders' THEN target_id := NEW.id; ELSE target_id := NEW.order_id; END IF;
  SELECT * INTO subject FROM commission_orders WHERE id = target_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Commission aggregate is missing' USING ERRCODE = '23514'; END IF;
  SELECT * INTO brief FROM commission_briefs WHERE order_id = target_id;
  IF NOT FOUND OR brief.created_at <> subject.created_at THEN RAISE EXCEPTION 'Commission brief must commit with order' USING ERRCODE = '23514'; END IF;
  IF NOT EXISTS (SELECT 1 FROM commission_events WHERE order_id = target_id AND order_version = subject.version AND type = subject.state AND occurred_at = subject.updated_at) THEN
    RAISE EXCEPTION 'Commission transition evidence must commit together' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO package FROM commission_package_revisions WHERE id = subject.package_revision_id;
  SELECT * INTO buyer FROM commission_acceptances WHERE order_id = target_id AND role = 'buyer';
  SELECT * INTO creator FROM commission_acceptances WHERE order_id = target_id AND role = 'creator';
  IF buyer.id IS NOT NULL AND (buyer.actor_user_id <> subject.buyer_user_id OR buyer.package_revision_id <> subject.package_revision_id OR buyer.accepted_at < subject.created_at) THEN
    RAISE EXCEPTION 'Commission buyer acceptance mismatch' USING ERRCODE = '23514';
  END IF;
  IF creator.id IS NOT NULL AND (creator.actor_user_id <> subject.creator_user_id OR creator.package_revision_id <> subject.package_revision_id) THEN
    RAISE EXCEPTION 'Commission creator acceptance mismatch' USING ERRCODE = '23514';
  END IF;
  IF subject.route <> 'custom_quote' AND (buyer.id IS NULL OR buyer.policy_revision_id <> package.policy_revision_id OR buyer.quote_revision_id IS NOT NULL OR buyer.accepted_at <> subject.created_at) THEN
    RAISE EXCEPTION 'Fixed commission requires original buyer acceptance' USING ERRCODE = '23514';
  END IF;
  IF subject.current_quote_id IS NOT NULL THEN
    SELECT * INTO quote FROM commission_quote_revisions WHERE id = subject.current_quote_id;
    IF NOT FOUND OR subject.route <> 'custom_quote' OR quote.order_id <> target_id
      OR quote.issued_at < subject.created_at OR quote.expires_at > subject.created_at + interval '30 days'
      OR (subject.state = 'quoted' AND subject.expires_at <> quote.expires_at) THEN
      RAISE EXCEPTION 'Commission quote binding/deadline mismatch' USING ERRCODE = '23514';
    END IF;
  END IF;
  SELECT * INTO snapshot FROM commission_terms_snapshots WHERE order_id = target_id;
  SELECT * INTO reservation FROM commission_reservations WHERE order_id = target_id;
  IF subject.accepted_at IS NULL THEN
    IF snapshot.order_id IS NOT NULL OR reservation.order_id IS NOT NULL OR creator.id IS NOT NULL
      OR (subject.route = 'custom_quote' AND buyer.id IS NOT NULL) THEN
      RAISE EXCEPTION 'Unaccepted commission cannot reserve or lock terms' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF snapshot.order_id IS NULL OR reservation.order_id IS NULL OR buyer.id IS NULL OR creator.id IS NULL
      OR snapshot.package_revision_id <> subject.package_revision_id OR snapshot.amount_vnd <> subject.amount_vnd
      OR snapshot.created_at <> subject.accepted_at OR snapshot.buyer_accepted_at <> buyer.accepted_at
      OR snapshot.creator_accepted_at <> creator.accepted_at OR buyer.policy_revision_id <> snapshot.policy_revision_id
      OR creator.policy_revision_id <> snapshot.policy_revision_id OR reservation.creator_user_id <> subject.creator_user_id
      OR reservation.reserved_at <> subject.accepted_at OR subject.expires_at <> subject.accepted_at + interval '24 hours' THEN
      RAISE EXCEPTION 'Commission commitment must be atomic and exact' USING ERRCODE = '23514';
    END IF;
    IF subject.route = 'custom_quote' THEN
      IF quote.id IS NULL OR snapshot.quote_revision_id IS DISTINCT FROM quote.id
        OR buyer.quote_revision_id IS DISTINCT FROM quote.id OR creator.quote_revision_id IS DISTINCT FROM quote.id
        OR snapshot.policy_revision_id <> quote.policy_revision_id OR snapshot.amount_vnd <> quote.amount_vnd
        OR snapshot.turnaround_days <> quote.turnaround_days OR snapshot.revision_allowance <> quote.revision_allowance
        OR snapshot.review_window_days <> quote.review_window_days OR subject.accepted_at >= quote.expires_at THEN
        RAISE EXCEPTION 'Accepted quote must match the locked terms' USING ERRCODE = '23514';
      END IF;
    ELSE
      IF snapshot.quote_revision_id IS NOT NULL OR creator.quote_revision_id IS NOT NULL OR snapshot.policy_revision_id <> package.policy_revision_id
        OR snapshot.amount_vnd <> (package.terms->>'amountVnd')::bigint
        OR snapshot.turnaround_days <> (package.terms->>'turnaroundDays')::integer
        OR snapshot.revision_allowance <> (package.terms->>'revisionAllowance')::integer
        OR snapshot.review_window_days <> (package.terms->>'reviewWindowDays')::integer THEN
        RAISE EXCEPTION 'Fixed commitment must retain original package terms' USING ERRCODE = '23514';
      END IF;
    END IF;
    IF (subject.state = 'awaiting_payment' AND reservation.state <> 'reserved')
      OR (subject.state = 'in_progress' AND (reservation.state <> 'occupied' OR reservation.occupied_at IS DISTINCT FROM subject.confirmed_at
        OR subject.due_at IS DISTINCT FROM subject.confirmed_at + snapshot.turnaround_days * interval '24 hours'))
      OR (subject.state = 'closed' AND (reservation.state <> 'released' OR reservation.released_at IS DISTINCT FROM subject.closed_at)) THEN
      RAISE EXCEPTION 'Commission reservation/fulfillment mismatch' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
DO $$
DECLARE target text;
BEGIN
  FOREACH target IN ARRAY ARRAY['commission_orders','commission_briefs','commission_quote_revisions',
    'commission_terms_snapshots','commission_acceptances','commission_reservations','commission_events'] LOOP
    EXECUTE format('CREATE CONSTRAINT TRIGGER %I AFTER INSERT OR UPDATE ON %I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION commission_check_order_graph()', target || '_graph', target);
  END LOOP;
END;
$$;
