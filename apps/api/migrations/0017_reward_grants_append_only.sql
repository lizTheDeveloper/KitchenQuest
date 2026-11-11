-- Custom SQL migration file, put your code below! --
-- M5 Step 12 (spec §6, never rule 6, Ruling 6): reward_grants is append-only. Nothing earned is taken back, so no
-- code path may change a grant once it is written. A trigger rejects every UPDATE, for every role that connects,
-- the app's included. DELETE stays possible on purpose: the account-delete cascade (users → reward_grants, ON DELETE
-- CASCADE) must erase a player's grants (GDPR Art. 17). No other code path deletes a grant; an architecture grep
-- over apps/api/src pins that (apps/api/test/never-take-back.test.ts).
CREATE FUNCTION reward_grants_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'reward_grants is append-only: % is not allowed', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$$;
--> statement-breakpoint
CREATE TRIGGER reward_grants_append_only
  BEFORE UPDATE ON reward_grants
  FOR EACH ROW EXECUTE FUNCTION reward_grants_guard();
