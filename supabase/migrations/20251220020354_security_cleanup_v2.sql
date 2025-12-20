BEGIN;

-- =========================================
-- 1) Fix payments FK default (critical)
-- =========================================
ALTER TABLE public.payments
  ALTER COLUMN form_submission_id DROP DEFAULT;

-- =========================================
-- 2) Ensure payments has strict invariants
-- =========================================
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payments_requires_stripe_id') THEN
    ALTER TABLE public.payments
      ADD CONSTRAINT payments_requires_stripe_id
      CHECK (
        stripe_payment_intent_id IS NOT NULL
        OR stripe_checkout_session_id IS NOT NULL
      ) NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payments_currency_check') THEN
    ALTER TABLE public.payments
      ADD CONSTRAINT payments_currency_check
      CHECK (
        currency = lower(currency)
        AND currency ~ '^[a-z]{3}$'
      ) NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payments_pi_id_format') THEN
    ALTER TABLE public.payments
      ADD CONSTRAINT payments_pi_id_format
      CHECK (stripe_payment_intent_id IS NULL OR stripe_payment_intent_id ~ '^pi_[A-Za-z0-9]+$')
      NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payments_cs_id_format') THEN
    ALTER TABLE public.payments
      ADD CONSTRAINT payments_cs_id_format
      CHECK (stripe_checkout_session_id IS NULL OR stripe_checkout_session_id ~ '^cs_[A-Za-z0-9]+$')
      NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payments_cus_id_format') THEN
    ALTER TABLE public.payments
      ADD CONSTRAINT payments_cus_id_format
      CHECK (stripe_customer_id IS NULL OR stripe_customer_id ~ '^cus_[A-Za-z0-9]+$')
      NOT VALID;
  END IF;
END $$;

-- =========================================
-- 3) Lock down grants (stripe_events created after your earlier lockdown)
-- =========================================
REVOKE ALL ON TABLE public.stripe_events FROM anon;
REVOKE ALL ON TABLE public.stripe_events FROM authenticated;

-- keep service_role usable
GRANT ALL ON TABLE public.stripe_events TO service_role;

-- =========================================
-- 4) Ensure service_role policies exist (your earlier migration printed "does not exist")
-- =========================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND tablename='stripe_events'
      AND policyname='service_role_all_stripe_events'
  ) THEN
    EXECUTE 'CREATE POLICY service_role_all_stripe_events
             ON public.stripe_events
             FOR ALL TO service_role
             USING (true) WITH CHECK (true)';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND tablename='form_submissions'
      AND policyname='service_role_all_form_submissions'
  ) THEN
    EXECUTE 'CREATE POLICY service_role_all_form_submissions
             ON public.form_submissions
             FOR ALL TO service_role
             USING (true) WITH CHECK (true)';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND tablename='payments'
      AND policyname='service_role_all_payments'
  ) THEN
    EXECUTE 'CREATE POLICY service_role_all_payments
             ON public.payments
             FOR ALL TO service_role
             USING (true) WITH CHECK (true)';
  END IF;
END $$;

-- =========================================
-- 5) Remove dangerous default privileges for future objects (optional but correct)
-- =========================================
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON SEQUENCES FROM authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM authenticated;

COMMIT;
