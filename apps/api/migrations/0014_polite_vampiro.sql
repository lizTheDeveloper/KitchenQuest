CREATE TABLE "market_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"sealed" "bytea" NOT NULL,
	"done_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "meal_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"week_start" date NOT NULL,
	"sealed" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "self_read_counts" DROP CONSTRAINT "self_read_counts_resource_check";--> statement-breakpoint
ALTER TABLE "market_runs" ADD CONSTRAINT "market_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_runs" ADD CONSTRAINT "market_runs_plan_id_meal_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."meal_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meal_plans" ADD CONSTRAINT "meal_plans_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "market_runs_plan_idx" ON "market_runs" USING btree ("plan_id");--> statement-breakpoint
CREATE INDEX "market_runs_user_id_idx" ON "market_runs" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "meal_plans_user_week_idx" ON "meal_plans" USING btree ("user_id","week_start");--> statement-breakpoint
ALTER TABLE "self_read_counts" ADD CONSTRAINT "self_read_counts_resource_check" CHECK ("self_read_counts"."resource" in ('rules', 'meals', 'pantry', 'progress', 'plans'));