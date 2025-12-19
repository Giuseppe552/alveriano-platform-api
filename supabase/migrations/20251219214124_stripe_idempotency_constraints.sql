-- Purpose:
-- Make webhook processing and payment writes idempotent + enforce data invariants.
-- This migration is designed to be safe to re-run (IF NOT EXISTS / NOT VALID where appropriate).

begin;

-- ----------------------------
-- 1) stripe_events table (missing today)
-- ----------------------------
create table if not exists "public"."stripe_events" (
  "event_id" text primary key,
  "type" text not null,
  "status" text not null default 'processing',
  "livemode" boolean not null default false,
  "created" bigint null,
  "processed_at" timestamptz null,
  "last_error" text null,
  "inserted_at" timestamptz not null default now()
);

-- Keep RLS posture consistent with your other tables
alter table "public"."stripe_events" enable row level security;

-- Minimal status constraint (NOT VALID so it won't break if old data exists later)
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'stripe_events_status_check'
  ) then
    alter table "public"."stripe_events"
      add constraint "stripe_events_status_check"
      check (status in ('processing','succeeded','failed')) not valid;
  end if;
end $$;

-- Useful operational indexes
create index if not exists "stripe_events_status_idx"
  on "public"."stripe_events" ("status");

create index if not exists "stripe_events_processed_at_idx"
  on "public"."stripe_events" ("processed_at");

-- Grants: mirror existing pattern in your dump.
-- RLS still blocks anon/authenticated unless you add policies.
grant all on table "public"."stripe_events" to "anon";
grant all on table "public"."stripe_events" to "authenticated";
grant all on table "public"."stripe_events" to "service_role";

-- ----------------------------
-- 2) form_submissions: idempotency key for paid flow
-- ----------------------------
alter table "public"."form_submissions"
  add column if not exists "submission_key" text null;

-- Partial unique index: only applies when submission_key is present
-- This makes createFormSubmission upserts real and race-safe.
create unique index if not exists "form_submissions_site_form_slug_submission_key_uidx"
  on "public"."form_submissions" ("site", "form_slug", "submission_key")
  where "submission_key" is not null;

-- Optional: constrain status values (NOT VALID = safe rollout)
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'form_submissions_status_check'
  ) then
    alter table "public"."form_submissions"
      add constraint "form_submissions_status_check"
      check (status in ('new','pending_payment','converted','spam','error')) not valid;
  end if;
end $$;

-- ----------------------------
-- 3) payments: idempotency + invariants
-- ----------------------------

-- Unique where not null: both identifiers must not duplicate across rows.
create unique index if not exists "payments_stripe_payment_intent_id_uidx"
  on "public"."payments" ("stripe_payment_intent_id")
  where "stripe_payment_intent_id" is not null;

create unique index if not exists "payments_stripe_checkout_session_id_uidx"
  on "public"."payments" ("stripe_checkout_session_id")
  where "stripe_checkout_session_id" is not null;

-- Optional correctness checks (NOT VALID = safe rollout)
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'payments_amount_cents_check'
  ) then
    alter table "public"."payments"
      add constraint "payments_amount_cents_check"
      check (amount_cents > 0) not valid;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'payments_status_check'
  ) then
    alter table "public"."payments"
      add constraint "payments_status_check"
      check (status in ('succeeded','failed','refunded','processing','requires_action')) not valid;
  end if;
end $$;

commit;
