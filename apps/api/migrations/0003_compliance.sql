CREATE TABLE "audit_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_id" text,
	"subject_user_id" text,
	"action" text NOT NULL,
	"target" text,
	"request_id" text,
	CONSTRAINT "audit_events_actor_kind_check" CHECK ("audit_events"."actor_kind" in ('user', 'system', 'operator', 'script'))
);
--> statement-breakpoint
CREATE TABLE "consents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"notice_version" text NOT NULL,
	"notice_sha256" "bytea" NOT NULL,
	"granted_at" timestamp with time zone NOT NULL,
	"withdrawn_at" timestamp with time zone,
	"method" text NOT NULL,
	CONSTRAINT "consents_purpose_check" CHECK ("consents"."purpose" in ('health_data', 'ai_health', 'voice', 'pantry_location', 'research')),
	CONSTRAINT "consents_method_check" CHECK ("consents"."method" in ('tap', 'api')),
	CONSTRAINT "consents_sha256_check" CHECK (octet_length("consents"."notice_sha256") = 32)
);
--> statement-breakpoint
CREATE TABLE "user_keys" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"key_id" text NOT NULL,
	"wrapped" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_keys" ADD CONSTRAINT "user_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_subject_idx" ON "audit_events" USING btree ("subject_user_id");--> statement-breakpoint
CREATE INDEX "audit_events_actor_idx" ON "audit_events" USING btree ("actor_id");--> statement-breakpoint
CREATE INDEX "audit_events_at_idx" ON "audit_events" USING btree ("at");--> statement-breakpoint
CREATE INDEX "consents_user_purpose_idx" ON "consents" USING btree ("user_id","purpose");--> statement-breakpoint
CREATE UNIQUE INDEX "consents_one_active_idx" ON "consents" USING btree ("user_id","purpose") WHERE "consents"."withdrawn_at" is null;