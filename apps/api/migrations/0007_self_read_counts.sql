CREATE TABLE "self_read_counts" (
	"user_id" uuid NOT NULL,
	"resource" text NOT NULL,
	"day" date NOT NULL,
	"count" integer NOT NULL,
	CONSTRAINT "self_read_counts_user_id_resource_day_pk" PRIMARY KEY("user_id","resource","day"),
	CONSTRAINT "self_read_counts_resource_check" CHECK ("self_read_counts"."resource" in ('rules')),
	CONSTRAINT "self_read_counts_count_check" CHECK ("self_read_counts"."count" > 0)
);
--> statement-breakpoint
ALTER TABLE "self_read_counts" ADD CONSTRAINT "self_read_counts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;