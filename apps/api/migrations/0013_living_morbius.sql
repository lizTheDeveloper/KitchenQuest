CREATE TABLE "progress_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"seq" bigserial NOT NULL,
	"client_id" text NOT NULL,
	"kind" text NOT NULL,
	"at" date NOT NULL,
	"body" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "progress_events_kind_check" CHECK ("progress_events"."kind" in ('lesson', 'drill', 'cooked', 'frame_cooked', 'quest_step', 'quest_done', 'recognized', 'market_run', 'meal_logged', 'imported'))
);
--> statement-breakpoint
CREATE TABLE "reward_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"body" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reward_grants_kind_check" CHECK ("reward_grants"."kind" in ('xp', 'stamp', 'trust', 'level', 'certificate'))
);
--> statement-breakpoint
ALTER TABLE "self_read_counts" DROP CONSTRAINT "self_read_counts_resource_check";--> statement-breakpoint
ALTER TABLE "progress_events" ADD CONSTRAINT "progress_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reward_grants" ADD CONSTRAINT "reward_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "progress_events_user_client_idx" ON "progress_events" USING btree ("user_id","client_id");--> statement-breakpoint
CREATE INDEX "progress_events_user_at_idx" ON "progress_events" USING btree ("user_id","at");--> statement-breakpoint
CREATE INDEX "reward_grants_user_id_idx" ON "reward_grants" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "self_read_counts" ADD CONSTRAINT "self_read_counts_resource_check" CHECK ("self_read_counts"."resource" in ('rules', 'meals', 'pantry', 'progress'));