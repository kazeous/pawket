CREATE TABLE "payments_sepay_provider_budgets" (
	"environment" text PRIMARY KEY NOT NULL,
	"window_started_at" timestamp with time zone NOT NULL,
	"request_count" integer NOT NULL,
	"blocked_until" timestamp with time zone,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "sepay_budget_environment_check" CHECK ("payments_sepay_provider_budgets"."environment" in ('test','live')),
	CONSTRAINT "sepay_budget_count_check" CHECK ("payments_sepay_provider_budgets"."request_count" between 0 and 30),
	CONSTRAINT "sepay_budget_time_check" CHECK ("payments_sepay_provider_budgets"."updated_at" >= "payments_sepay_provider_budgets"."window_started_at")
);
