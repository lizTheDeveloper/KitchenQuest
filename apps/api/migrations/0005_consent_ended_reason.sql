ALTER TABLE "consents" ADD COLUMN "ended_reason" text;--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_ended_reason_check" CHECK ("consents"."ended_reason" in ('withdrawn', 'superseded'));--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_ended_check" CHECK (("consents"."withdrawn_at" is null) = ("consents"."ended_reason" is null));