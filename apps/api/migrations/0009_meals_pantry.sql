CREATE TABLE "meal_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"eaten_on" date NOT NULL,
	"slot" text NOT NULL,
	"sealed" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meal_logs_slot_check" CHECK ("meal_logs"."slot" in ('breakfast', 'lunch', 'dinner', 'snack', 'other'))
);
--> statement-breakpoint
CREATE TABLE "pantry_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"sealed" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "self_read_counts" DROP CONSTRAINT "self_read_counts_resource_check";--> statement-breakpoint
ALTER TABLE "meal_logs" ADD CONSTRAINT "meal_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pantry_items" ADD CONSTRAINT "pantry_items_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "meal_logs_user_eaten_on_idx" ON "meal_logs" USING btree ("user_id","eaten_on");--> statement-breakpoint
CREATE INDEX "pantry_items_user_id_idx" ON "pantry_items" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "self_read_counts" ADD CONSTRAINT "self_read_counts_resource_check" CHECK ("self_read_counts"."resource" in ('rules', 'meals', 'pantry'));