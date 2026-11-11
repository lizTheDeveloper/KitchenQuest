CREATE TABLE "margin_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"recipe" text NOT NULL,
	"sealed" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shared_table" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"cooked_on" date NOT NULL,
	"sealed" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "self_read_counts" DROP CONSTRAINT "self_read_counts_resource_check";--> statement-breakpoint
ALTER TABLE "consents" ADD COLUMN "subject_kind" text DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE "consents" ADD COLUMN "subject_id" uuid;--> statement-breakpoint
ALTER TABLE "margin_notes" ADD CONSTRAINT "margin_notes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_table" ADD CONSTRAINT "shared_table_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "margin_notes_user_recipe_idx" ON "margin_notes" USING btree ("user_id","recipe");--> statement-breakpoint
CREATE INDEX "shared_table_user_id_idx" ON "shared_table" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_subject_kind_check" CHECK ("consents"."subject_kind" = 'user');--> statement-breakpoint
ALTER TABLE "self_read_counts" ADD CONSTRAINT "self_read_counts_resource_check" CHECK ("self_read_counts"."resource" in ('rules', 'meals', 'pantry', 'progress', 'plans', 'notes'));