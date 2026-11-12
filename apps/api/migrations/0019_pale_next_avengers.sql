CREATE TABLE "progress_snapshots" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"upto_seq" bigint NOT NULL,
	"catalogue_hash" text NOT NULL,
	"sealed" "bytea" NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "progress_snapshots" ADD CONSTRAINT "progress_snapshots_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;