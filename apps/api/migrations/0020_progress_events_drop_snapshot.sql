-- Custom SQL migration file, put your code below! --
-- M6 Step 7 (Ruling 18; M5 m12): progress_snapshots is a cache of the progress fold, never a record. Whenever any
-- progress event is deleted (a meal-log undo's FK cascade, a health_data delete's meal-log and stall-round erase,
-- anything later), the player's snapshot goes in the same transaction, so a snapshot can never outlive an erased
-- event: the next read rebuilds it from the ledgers. A trigger, not code, so no code path can forget. Never disabled.
CREATE FUNCTION progress_events_drop_snapshot() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM progress_snapshots WHERE user_id = OLD.user_id;
  RETURN OLD;
END
$$;
--> statement-breakpoint
CREATE TRIGGER progress_events_drop_snapshot
  AFTER DELETE ON progress_events
  FOR EACH ROW EXECUTE FUNCTION progress_events_drop_snapshot();
