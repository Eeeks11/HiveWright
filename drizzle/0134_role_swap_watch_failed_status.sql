ALTER TABLE "role_model_swap_watches"
  DROP CONSTRAINT IF EXISTS "role_model_swap_watches_status_chk";

ALTER TABLE "role_model_swap_watches"
  ADD CONSTRAINT "role_model_swap_watches_status_chk"
  CHECK ("status" IN ('watching', 'failed', 'reverted', 'passed'));
