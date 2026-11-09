-- Custom SQL migration file, put your code below! --
-- C-5 hardening of 0004_audit_append_only (review fix):
-- * Pseudonymization is allowed only for a user id that is a uuid AND has no
--   users row (account delete removes the user first, then pseudonymizes in
--   the same transaction).
-- * The pseudonym is computed here, HMAC-SHA256(user id, pseudonym key), not
--   supplied by the caller. The key (PSEUDONYM_KEY) is passed per call and is
--   never stored in the database.
-- * The trigger requires the new value to be exactly that pseudonym.
-- * EXECUTE on the maintenance functions is revoked from PUBLIC.
-- The trigger guards against bugs, not a hostile app: the app connects as the
-- table owner and could disable or drop it until it runs as its own role (C-42).
CREATE OR REPLACE FUNCTION audit_events_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  subject text := coalesce(current_setting('kq.audit_pseudonymize', true), '');
  pseudonym text := coalesce(current_setting('kq.audit_pseudonym', true), '');
  purge_before text := coalesce(current_setting('kq.audit_purge_before', true), '');
BEGIN
  IF TG_OP = 'UPDATE'
     AND subject ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     AND pseudonym ~ '^p:[0-9a-f]{64}$'
     AND NOT EXISTS (SELECT 1 FROM users WHERE id = subject::uuid)
     AND NEW.id = OLD.id
     AND NEW.at = OLD.at
     AND NEW.actor_kind = OLD.actor_kind
     AND NEW.action = OLD.action
     AND NEW.target IS NOT DISTINCT FROM OLD.target
     AND NEW.request_id IS NOT DISTINCT FROM OLD.request_id
     AND (NEW.subject_user_id IS NOT DISTINCT FROM OLD.subject_user_id
          OR (OLD.subject_user_id = subject AND NEW.subject_user_id = pseudonym))
     AND (NEW.actor_id IS NOT DISTINCT FROM OLD.actor_id
          OR (OLD.actor_id = subject AND NEW.actor_id = pseudonym))
  THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' AND purge_before <> ''
     AND OLD.at < purge_before::timestamptz
     AND OLD.at < now() - interval '24 months'
  THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'audit_events is append-only: % is not allowed', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$$;
--> statement-breakpoint
DROP FUNCTION audit_pseudonymize(uuid, text);
--> statement-breakpoint
CREATE FUNCTION audit_pseudonymize(subject uuid, pseudonym_key bytea) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  n integer;
  pseudonym text;
BEGIN
  IF subject IS NULL OR pseudonym_key IS NULL OR octet_length(pseudonym_key) <> 32 THEN
    RAISE EXCEPTION 'audit_pseudonymize: needs a user id and a 32-byte key';
  END IF;
  IF EXISTS (SELECT 1 FROM users WHERE id = subject) THEN
    RAISE EXCEPTION 'audit_pseudonymize: the user still exists; delete the account first';
  END IF;
  pseudonym := 'p:' || encode(hmac(convert_to(subject::text, 'UTF8'), pseudonym_key, 'sha256'), 'hex');
  PERFORM set_config('kq.audit_pseudonymize', subject::text, true);
  PERFORM set_config('kq.audit_pseudonym', pseudonym, true);
  UPDATE audit_events SET
    subject_user_id = CASE WHEN subject_user_id = subject::text THEN pseudonym ELSE subject_user_id END,
    actor_id = CASE WHEN actor_id = subject::text THEN pseudonym ELSE actor_id END
  WHERE subject_user_id = subject::text OR actor_id = subject::text;
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM set_config('kq.audit_pseudonymize', '', true);
  PERFORM set_config('kq.audit_pseudonym', '', true);
  RETURN n;
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION audit_pseudonymize(uuid, bytea) FROM PUBLIC;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION audit_purge_before(timestamptz) FROM PUBLIC;
