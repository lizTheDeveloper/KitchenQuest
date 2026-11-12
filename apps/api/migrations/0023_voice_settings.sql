CREATE TABLE "voice_settings" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"sealed" "bytea" NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "voice_settings_sealed_check" CHECK (case when octet_length("voice_settings"."sealed") = 0 then false else octet_length("voice_settings"."sealed") = get_byte("voice_settings"."sealed", 0) + 93 end)
);
--> statement-breakpoint
ALTER TABLE "self_read_counts" DROP CONSTRAINT "self_read_counts_resource_check";--> statement-breakpoint
ALTER TABLE "voice_settings" ADD CONSTRAINT "voice_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entitlements" ADD CONSTRAINT "entitlements_retired_kind_check" CHECK ("entitlements"."kind" <> 'accessibility_voice');--> statement-breakpoint
ALTER TABLE "self_read_counts" ADD CONSTRAINT "self_read_counts_resource_check" CHECK ("self_read_counts"."resource" in ('rules', 'meals', 'pantry', 'progress', 'plans', 'notes', 'voice'));