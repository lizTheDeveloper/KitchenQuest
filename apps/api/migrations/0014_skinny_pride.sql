ALTER TABLE "progress_events" ADD COLUMN "meal_log_id" uuid;--> statement-breakpoint
ALTER TABLE "progress_events" ADD CONSTRAINT "progress_events_meal_log_id_meal_logs_id_fk" FOREIGN KEY ("meal_log_id") REFERENCES "public"."meal_logs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "progress_events_meal_log_idx" ON "progress_events" USING btree ("user_id","meal_log_id") WHERE "progress_events"."meal_log_id" is not null;--> statement-breakpoint
ALTER TABLE "reward_grants" DROP COLUMN "created_at";--> statement-breakpoint
ALTER TABLE "progress_events" ADD CONSTRAINT "progress_events_meal_log_check" CHECK (("progress_events"."kind" = 'meal_logged') = ("progress_events"."meal_log_id" is not null));