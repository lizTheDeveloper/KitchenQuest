-- Custom SQL migration file, put your code below! --
-- C-5: audit_events is append-only for every role that connects, the app's included.
-- A trigger rejects UPDATE, DELETE and TRUNCATE. The only exceptions are the two
-- maintenance functions below, which set a transaction-local flag the trigger checks,
-- and even then the trigger allows only the narrow change each one makes:
--   audit_pseudonymize(user, pseudonym): replace that user's id in subject_user_id
--     or actor_id with a `p:<64 hex>` pseudonym; nothing else on the row may change.
--   audit_purge_before(cutoff): delete rows older than the cutoff, which is clamped
--     to the database's own now() - 24 months, so younger rows can never be deleted.
-- See docs/compliance/key-management.md ("Audit log") for the threat model.
CREATE FUNCTION audit_events_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  pseudonymize text := coalesce(current_setting('kq.audit_pseudonymize', true), '');
  purge_before text := coalesce(current_setting('kq.audit_purge_before', true), '');
BEGIN
  IF TG_OP = 'UPDATE' AND pseudonymize <> ''
     AND NEW.id = OLD.id
     AND NEW.at = OLD.at
     AND NEW.actor_kind = OLD.actor_kind
     AND NEW.action = OLD.action
     AND NEW.target IS NOT DISTINCT FROM OLD.target
     AND NEW.request_id IS NOT DISTINCT FROM OLD.request_id
     AND (NEW.subject_user_id IS NOT DISTINCT FROM OLD.subject_user_id
          OR (OLD.subject_user_id = pseudonymize AND NEW.subject_user_id ~ '^p:[0-9a-f]{64}$'))
     AND (NEW.actor_id IS NOT DISTINCT FROM OLD.actor_id
          OR (OLD.actor_id = pseudonymize AND NEW.actor_id ~ '^p:[0-9a-f]{64}$'))
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
CREATE TRIGGER audit_events_append_only
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_guard();
--> statement-breakpoint
CREATE TRIGGER audit_events_no_truncate
  BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION audit_events_guard();
--> statement-breakpoint
-- SECURITY DEFINER so that, once the app runs as its own role (C-42), UPDATE and
-- DELETE on audit_events can be revoked from it and these stay the only path.
CREATE FUNCTION audit_pseudonymize(subject uuid, pseudonym text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  n integer;
BEGIN
  IF pseudonym IS NULL OR pseudonym !~ '^p:[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'audit_pseudonymize: pseudonym must be p: and 64 hex digits';
  END IF;
  PERFORM set_config('kq.audit_pseudonymize', subject::text, true);
  UPDATE audit_events SET
    subject_user_id = CASE WHEN subject_user_id = subject::text THEN pseudonym ELSE subject_user_id END,
    actor_id = CASE WHEN actor_id = subject::text THEN pseudonym ELSE actor_id END
  WHERE subject_user_id = subject::text OR actor_id = subject::text;
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM set_config('kq.audit_pseudonymize', '', true);
  RETURN n;
END
$$;
--> statement-breakpoint
CREATE FUNCTION audit_purge_before(cutoff timestamptz) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  n integer;
  effective timestamptz := least(cutoff, now() - interval '24 months');
BEGIN
  PERFORM set_config('kq.audit_purge_before', effective::text, true);
  DELETE FROM audit_events WHERE at < effective;
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM set_config('kq.audit_purge_before', '', true);
  RETURN n;
END
$$;
