-- Lock down public tables so anon/authenticated can’t access them even if RLS is misconfigured.
-- We keep service_role access for Lambda/server-side workflows.

begin;

-- 1) Revoke table privileges from anon/authenticated (defense in depth)
revoke all on table public.form_submissions from anon, authenticated;
revoke all on table public.payments from anon, authenticated;
revoke all on table public.stripe_events from anon, authenticated;

-- 2) Ensure RLS is enabled + forced (owner can’t bypass policies accidentally)
alter table public.form_submissions enable row level security;
alter table public.payments enable row level security;
alter table public.stripe_events enable row level security;

alter table public.form_submissions force row level security;
alter table public.payments force row level security;
alter table public.stripe_events force row level security;

-- 3) Defense-in-depth policies for service_role
-- (Even though service_role can bypass RLS, having explicit policies makes intent audit-friendly.)
drop policy if exists "service_role_all_form_submissions" on public.form_submissions;
create policy "service_role_all_form_submissions"
  on public.form_submissions
  for all
  to service_role
  using (true)
  with check (true);

drop policy if exists "service_role_all_payments" on public.payments;
create policy "service_role_all_payments"
  on public.payments
  for all
  to service_role
  using (true)
  with check (true);

drop policy if exists "service_role_all_stripe_events" on public.stripe_events;
create policy "service_role_all_stripe_events"
  on public.stripe_events
  for all
  to service_role
  using (true)
  with check (true);

commit;
