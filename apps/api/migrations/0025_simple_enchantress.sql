ALTER TABLE "users" ADD COLUMN "health_erasure" uuid;--> statement-breakpoint
CREATE INDEX "progress_events_user_imported_idx" ON "progress_events" USING btree ("user_id") WHERE "progress_events"."kind" = 'imported';--> statement-breakpoint
CREATE INDEX "reward_grants_user_event_idx" ON "reward_grants" USING btree ("user_id",("body"->>'eventId'));