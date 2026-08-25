CREATE TABLE "identity_creator_capability_events" (
  "id" uuid PRIMARY KEY NOT NULL,
  "capability_id" uuid NOT NULL,
  "action" text NOT NULL,
  "state" text NOT NULL,
  "version" integer NOT NULL,
  "actor_user_id" text NOT NULL,
  "actor_session_id" text NOT NULL,
  "step_up_proof_id" uuid NOT NULL,
  "reason_code" text NOT NULL,
  "request_id" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  CONSTRAINT "identity_creator_capability_events_capability_id_identity_creator_capabilities_id_fk" FOREIGN KEY ("capability_id") REFERENCES "identity_creator_capabilities"("id") ON DELETE restrict ON UPDATE restrict,
  CONSTRAINT "identity_creator_capability_events_actor_user_id_identity_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "identity_users"("id") ON DELETE restrict ON UPDATE restrict,
  CONSTRAINT "identity_creator_capability_events_action_check" CHECK ("action" in ('granted','suspended','reinstated')),
  CONSTRAINT "identity_creator_capability_events_state_check" CHECK ("state" in ('active','suspended')),
  CONSTRAINT "identity_creator_capability_events_version_check" CHECK ("version" > 0)
);--> statement-breakpoint
CREATE INDEX "identity_creator_capability_events_capability_idx" ON "identity_creator_capability_events" USING btree ("capability_id", "created_at");--> statement-breakpoint
CREATE OR REPLACE FUNCTION creator_reject_capability_event_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'creator capability events are append-only';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER identity_creator_capability_events_append_only
BEFORE UPDATE OR DELETE ON "identity_creator_capability_events"
FOR EACH ROW EXECUTE FUNCTION creator_reject_capability_event_mutation();
