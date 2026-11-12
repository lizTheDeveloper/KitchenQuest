-- Custom SQL migration file, put your code below! --
-- M7 Step 4 (README Ruling 6, C-19): the plain `accessibility_voice` entitlement is retired. A self-declared
-- accessibility need is health data (it implies a disability), so it lives only sealed, in `voice_settings`, under the
-- `health_data` consent. No such row was ever granted in production (no route grants it; `npm run grant` refused it from
-- this step); any left from development or tests are deleted here, before the next migration adds the check that
-- refuses the kind for good. The kind stays in `ENTITLEMENT_KINDS`, marked retired, so an old row would still parse.
DELETE FROM entitlements WHERE kind = 'accessibility_voice';
