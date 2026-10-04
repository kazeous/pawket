ALTER TABLE "payment_confirmations" DROP CONSTRAINT "payment_confirmations_assurance_time_check";--> statement-breakpoint
ALTER TABLE "payment_confirmations" ADD CONSTRAINT "payment_confirmations_assurance_time_check" CHECK ("payment_confirmations"."primary_authenticated_at" <= "payment_confirmations"."confirmed_at"
    and "payment_confirmations"."primary_authenticated_at" >= "payment_confirmations"."confirmed_at" - interval '60 minutes'
    and ("payment_confirmations"."mfa_verified_at" is null or ("payment_confirmations"."mfa_verified_at" <= "payment_confirmations"."confirmed_at" and "payment_confirmations"."mfa_verified_at" >= "payment_confirmations"."confirmed_at" - interval '60 minutes')));--> statement-breakpoint
ALTER TABLE "payments_sepay_account_cutovers" DROP CONSTRAINT "sepay_cutover_assurance_check";--> statement-breakpoint
ALTER TABLE "payments_sepay_account_cutovers" ADD CONSTRAINT "sepay_cutover_assurance_check" CHECK ("payments_sepay_account_cutovers"."primary_authenticated_at" between "payments_sepay_account_cutovers"."cutover_at" - interval '60 minutes' and "payments_sepay_account_cutovers"."cutover_at"
    and ("payments_sepay_account_cutovers"."mfa_verified_at" is null or "payments_sepay_account_cutovers"."mfa_verified_at" between "payments_sepay_account_cutovers"."cutover_at" - interval '60 minutes' and "payments_sepay_account_cutovers"."cutover_at"));
