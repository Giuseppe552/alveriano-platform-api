BEGIN;

-- 1) Remove the dangerous default
ALTER TABLE public.payments
  ALTER COLUMN form_submission_id DROP DEFAULT;

-- 2) Tighten invariants (these match how your API behaves)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'payments_amount_cents_nonnegative'
  ) THEN
    ALTER TABLE public.payments
      ADD CONSTRAINT payments_amount_cents_nonnegative
      CHECK (amount_cents >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'payments_currency_lowercase'
  ) THEN
    ALTER TABLE public.payments
      ADD CONSTRAINT payments_currency_lowercase
      CHECK (currency = lower(currency));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'payments_status_check'
  ) THEN
    ALTER TABLE public.payments
      ADD CONSTRAINT payments_status_check
      CHECK (status IN ('succeeded','failed','refunded','processing','requires_action'));
  END IF;

  -- require at least one stable Stripe identifier for idempotency
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'payments_requires_stripe_id'
  ) THEN
    ALTER TABLE public.payments
      ADD CONSTRAINT payments_requires_stripe_id
      CHECK (
        stripe_payment_intent_id IS NOT NULL
        OR stripe_checkout_session_id IS NOT NULL
      );
  END IF;

  -- optional but strong sanity checks (prevents garbage IDs)
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'payments_pi_id_format'
  ) THEN
    ALTER TABLE public.payments
      ADD CONSTRAINT payments_pi_id_format
      CHECK (stripe_payment_intent_id IS NULL OR stripe_payment_intent_id ~ '^pi_[A-Za-z0-9]+$');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'payments_cs_id_format'
  ) THEN
    ALTER TABLE public.payments
      ADD CONSTRAINT payments_cs_id_format
      CHECK (stripe_checkout_session_id IS NULL OR stripe_checkout_session_id ~ '^cs_[A-Za-z0-9]+$');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'payments_cus_id_format'
  ) THEN
    ALTER TABLE public.payments
      ADD CONSTRAINT payments_cus_id_format
      CHECK (stripe_customer_id IS NULL OR stripe_customer_id ~ '^cus_[A-Za-z0-9]+$');
  END IF;
END $$;

-- 3) Idempotency + query performance indexes
-- IMPORTANT: use partial unique indexes so NULLs don’t collide
CREATE UNIQUE INDEX IF NOT EXISTS payments_stripe_payment_intent_uidx
  ON public.payments (stripe_payment_intent_id)
  WHERE stripe_payment_intent_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS payments_stripe_checkout_session_uidx
  ON public.payments (stripe_checkout_session_id)
  WHERE stripe_checkout_session_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS payments_site_created_idx
  ON public.payments (site, created_at DESC);

COMMIT;
