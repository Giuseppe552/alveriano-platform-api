-- Add idempotency support for form submissions
-- Goal:
-- - optional submission_key column
-- - uniqueness when submission_key is present (site + form_slug + submission_key)
-- - basic guardrails for status + submission_key length
-- NOTE: Avoid CREATE INDEX CONCURRENTLY in Supabase migrations (runs in a transaction).

BEGIN;

-- 1) Add the column (server-side idempotency key)
ALTER TABLE public.form_submissions
  ADD COLUMN IF NOT EXISTS submission_key text;

COMMENT ON COLUMN public.form_submissions.submission_key IS
  'Optional idempotency key for submissions. When present, retries should return the existing row rather than creating duplicates.';

-- 2) Guardrail: submission_key length (matches API limits)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'form_submissions_submission_key_len_check'
  ) THEN
    ALTER TABLE public.form_submissions
      ADD CONSTRAINT form_submissions_submission_key_len_check
      CHECK (submission_key IS NULL OR char_length(submission_key) <= 128);
  END IF;
END $$;

-- 3) Guardrail: status should be one of known states
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'form_submissions_status_check'
  ) THEN
    ALTER TABLE public.form_submissions
      ADD CONSTRAINT form_submissions_status_check
      CHECK (status IN ('new','pending_payment','converted','spam','error'));
  END IF;
END $$;

-- 4) Idempotency: uniqueness only when submission_key is provided
-- This prevents duplicates for retries, without affecting free submissions.
CREATE UNIQUE INDEX IF NOT EXISTS form_submissions_idempotency_uidx
  ON public.form_submissions (site, form_slug, submission_key)
  WHERE submission_key IS NOT NULL;

-- 5) Useful query index for dashboards / admin filtering
CREATE INDEX IF NOT EXISTS form_submissions_site_slug_created_idx
  ON public.form_submissions (site, form_slug, created_at DESC);

COMMIT;
