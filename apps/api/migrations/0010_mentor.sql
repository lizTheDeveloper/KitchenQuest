CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_turn_at" timestamp with time zone DEFAULT now() NOT NULL,
	"turn_seq" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mentor_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"conversation_id" uuid,
	"turn_seq" integer,
	"kind" text NOT NULL,
	"severe" boolean NOT NULL,
	"status" text NOT NULL,
	"sealed" "bytea" NOT NULL,
	"undo_sealed" "bytea",
	"write_ref" uuid,
	"channel" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone,
	CONSTRAINT "mentor_proposals_kind_check" CHECK ("mentor_proposals"."kind" in ('rule', 'meal', 'profile', 'pantry')),
	CONSTRAINT "mentor_proposals_status_check" CHECK ("mentor_proposals"."status" in ('open', 'confirmed', 'rejected', 'expired', 'undone')),
	CONSTRAINT "mentor_proposals_channel_check" CHECK ("mentor_proposals"."channel" in ('tap', 'typed_yes'))
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"role" text NOT NULL,
	"sealed" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_role_check" CHECK ("messages"."role" in ('player', 'pan'))
);
--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mentor_proposals" ADD CONSTRAINT "mentor_proposals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mentor_proposals" ADD CONSTRAINT "mentor_proposals_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversations_user_id_idx" ON "conversations" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "conversations_last_turn_at_idx" ON "conversations" USING btree ("last_turn_at");--> statement-breakpoint
CREATE INDEX "mentor_proposals_user_id_idx" ON "mentor_proposals" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "mentor_proposals_conversation_turn_idx" ON "mentor_proposals" USING btree ("conversation_id","turn_seq");--> statement-breakpoint
CREATE INDEX "mentor_proposals_created_at_idx" ON "mentor_proposals" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_conversation_seq_idx" ON "messages" USING btree ("conversation_id","seq");--> statement-breakpoint
CREATE INDEX "messages_user_id_idx" ON "messages" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "messages_created_at_idx" ON "messages" USING btree ("created_at");