ALTER TABLE "conversations" ADD COLUMN "last_turn_key" text;--> statement-breakpoint
ALTER TABLE "rules" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;