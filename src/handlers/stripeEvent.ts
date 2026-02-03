import type Stripe from "stripe";
import { createPaymentRecord, type Currency } from "../payments";
import { supabase } from "../supabaseClient";

type StripeEventStatus = "processing" | "succeeded" | "failed";

type StripeEventRow = {
  event_id: string;
  type: string;
  status: StripeEventStatus;
  livemode: boolean;
  created: number | null;
  processed_at: string | null;
  last_error: string | null;
};

type HandleResult =
  | { ok: true; handled: true; paymentId: string; deduped?: boolean }
  | { ok: true; handled: false; deduped?: boolean };

function nowIso() {
  return new Date().toISOString();
}

function safeStr(v: unknown, max = 120): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max) : s;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function log(level: "info" | "warn" | "error", payload: Record<string, unknown>) {
  // no-console is fine in Lambda; this is your structured logging.
  console[level](
    JSON.stringify({
      ts: nowIso(),
      level,
      ...payload,
    })
  );
}

function isUniqueViolation(err: unknown): boolean {
  // Postgres unique violation is 23505.
  // Supabase/PostgREST typically exposes `code`.
  const code = (err as { code?: unknown })?.code;
  return typeof code === "string" && code === "23505";
}

function isCurrency(v: string): v is Currency {
  return v === "gbp" || v === "eur" || v === "usd";
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

async function postJsonWithRetries(args: {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  timeoutMs: number;
  attempts: number;
}) {
  let lastErr: unknown = null;
  for (let i = 0; i < args.attempts; i++) {
    try {
      const res = await fetch(args.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...args.headers },
        body: JSON.stringify(args.body),
        signal: AbortSignal.timeout(args.timeoutMs),
      });

      if (res.ok) return;
      const text = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    } catch (e) {
      lastErr = e;
      if (i < args.attempts - 1) {
        await new Promise((r) => setTimeout(r, 300 * (i + 1)));
      }
    }
  }
  throw lastErr ?? new Error("unknown_error");
}

async function notifyResinaroCrm(args: {
  eventId: string;
  eventType: string;
  site: string;
  formSlug: string | null;
  pricingTier: string | null;
  formSubmissionId: string | null;
  paymentIntentId: string;
  amountCents: number;
  currency: string;
  receiptEmail: string | null;
  metadata: Record<string, unknown> | null;
}) {
  if (args.site !== "resinaro") return;

  const url = process.env["RESINARO_CRM_WEBHOOK_URL"];
  const secret = process.env["RESINARO_CRM_WEBHOOK_SECRET"];
  if (!isNonEmptyString(url) || !isNonEmptyString(secret)) {
    log("error", {
      msg: "resinaro_crm_webhook_not_configured",
      hasUrl: Boolean(url && url.trim()),
      hasSecret: Boolean(secret && secret.trim()),
    });
    return;
  }

  await postJsonWithRetries({
    url,
    headers: { Authorization: `Bearer ${secret}` },
    body: {
      eventId: args.eventId,
      eventType: args.eventType,
      site: args.site,
      formSlug: args.formSlug,
      pricingTier: args.pricingTier,
      formSubmissionId: args.formSubmissionId,
      paymentIntentId: args.paymentIntentId,
      amountCents: args.amountCents,
      currency: args.currency,
      receiptEmail: args.receiptEmail,
      metadata: args.metadata,
    },
    timeoutMs: 6000,
    attempts: 3,
  });
}

/**
 * Claim the Stripe event for processing (idempotency + concurrency guard).
 *
 * DB REQUIREMENT:
 * - stripe_events.event_id UNIQUE
 */
async function claimStripeEvent(
  event: Stripe.Event
): Promise<
  | { claimed: true; row: StripeEventRow; inserted: true }
  | { claimed: false; row: StripeEventRow; reason: "already_succeeded" | "already_processing" | "missing" }
  | { claimed: true; row: StripeEventRow; inserted: false }
> {
  // Try insert (fast path).
  const insertRes = await (supabase as any)
    .from("stripe_events")
    .insert({
      event_id: event.id,
      type: event.type,
      status: "processing",
      livemode: event.livemode,
      created: typeof event.created === "number" ? event.created : null,
      processed_at: null,
      last_error: null,
    })
    .select("*")
    .maybeSingle();

  if (!insertRes.error && insertRes.data) {
    return { claimed: true, row: insertRes.data as StripeEventRow, inserted: true };
  }

  // If insert failed for non-duplicate reasons, explode so Stripe retries.
  if (insertRes.error && !isUniqueViolation(insertRes.error)) {
    throw new Error(`stripe_events insert failed: ${insertRes.error.message}`);
  }

  // Duplicate (already exists) — fetch existing
  const existingRes = await (supabase as any)
    .from("stripe_events")
    .select("*")
    .eq("event_id", event.id)
    .maybeSingle();

  if (existingRes.error) {
    throw new Error(`stripe_events fetch failed: ${existingRes.error.message}`);
  }
  if (!existingRes.data) {
    // Extremely rare: duplicate insert error but row not found.
    return { claimed: false, row: {
      event_id: event.id,
      type: event.type,
      status: "processing",
      livemode: event.livemode,
      created: typeof event.created === "number" ? event.created : null,
      processed_at: null,
      last_error: null,
    }, reason: "missing" };
  }

  const row = existingRes.data as StripeEventRow;

  if (row.status === "succeeded") {
    return { claimed: false, row, reason: "already_succeeded" };
  }

  if (row.status === "processing") {
    // We don’t have a lease timestamp column yet, so treat as locked.
    return { claimed: false, row, reason: "already_processing" };
  }

  // status === "failed" → re-claim by updating to processing
  const upd = await (supabase as any)
    .from("stripe_events")
    .update({
      status: "processing",
      processed_at: null,
      last_error: null,
    })
    .eq("event_id", event.id)
    .select("*")
    .maybeSingle();

  if (upd.error || !upd.data) {
    throw new Error(`stripe_events reclaim failed: ${upd.error?.message ?? "no row returned"}`);
  }

  return { claimed: true, row: upd.data as StripeEventRow, inserted: false };
}

async function markStripeEventStatus(
  eventId: string,
  status: StripeEventStatus,
  lastError?: string | null
) {
  const res = await (supabase as any)
    .from("stripe_events")
    .update({
      status,
      processed_at: nowIso(),
      last_error: lastError ?? null,
    })
    .eq("event_id", eventId);

  if (res.error) {
    throw new Error(`stripe_events update failed: ${res.error.message}`);
  }
}

/**
 * Core business logic for Stripe webhooks.
 * Idempotent via stripe_events table + payments unique constraints.
 */
export async function handleStripeEvent(
  event: Stripe.Event
): Promise<HandleResult> {
  // 0) claim event
  const claim = await claimStripeEvent(event);

  if (!claim.claimed) {
    if (claim.reason === "already_succeeded") {
      return { ok: true, handled: false, deduped: true };
    }
    if (claim.reason === "already_processing") {
      // Force Stripe retry later (prevents concurrent double-processing)
      throw new Error(`stripe_event_already_processing:${event.id}`);
    }
    // "missing" – weird edge case; fail for retry
    throw new Error(`stripe_event_missing_after_duplicate:${event.id}`);
  }

  log("info", {
    msg: "stripe_event_claimed",
    eventId: event.id,
    type: event.type,
    livemode: event.livemode,
    inserted: claim.inserted,
  });

  try {
    switch (event.type) {
      case "payment_intent.succeeded": {
        const pi = event.data.object as Stripe.PaymentIntent;

        assert(pi && typeof pi === "object", "Invalid payment_intent payload");
        assert(typeof pi.id === "string" && pi.id.length > 0, "Missing PaymentIntent.id");
        assert(typeof pi.currency === "string", "Missing PaymentIntent.currency");

        const metadata = (pi.metadata ?? {}) as Record<string, unknown>;

        const formSubmissionId = safeStr(metadata["form_submission_id"], 64);
        const site = (safeStr(metadata["site"], 32) ?? "unknown").toLowerCase();
        const formSlug = safeStr(metadata["form_slug"], 64);
        const pricingTier = safeStr(metadata["pricing_tier"], 64);

        const amountCents =
          typeof pi.amount_received === "number" ? pi.amount_received : pi.amount;

        assert(typeof amountCents === "number" && Number.isFinite(amountCents), "Invalid amount");
        assert(Number.isInteger(amountCents), "Stripe amount is not integer cents");

        const currencyRaw = pi.currency.toLowerCase();
        assert(isCurrency(currencyRaw), `Unsupported currency: ${currencyRaw}`);

        const customerId =
          typeof pi.customer === "string"
            ? pi.customer
            : (typeof (pi.customer as any)?.id === "string" ? (pi.customer as any).id : null);

        const eventSnapshot: Record<string, unknown> = {
          id: event.id,
          type: event.type,
          created: event.created,
          livemode: event.livemode,
          payment_intent_id: pi.id,
        };

        const paymentRow = await createPaymentRecord({
          site,
          formSubmissionId: formSubmissionId ?? null,
          amountCents,
          currency: currencyRaw,
          stripePaymentIntentId: pi.id,
          stripeCheckoutSessionId: null,
          stripeCustomerId: customerId,
          status: "succeeded",
          rawEvent: eventSnapshot,
        });

        if (formSubmissionId) {
          const upd = await (supabase as any)
            .from("form_submissions")
            .update({
              status: "converted",
              updated_at: nowIso(),
            })
            .eq("id", formSubmissionId);

          if (upd.error) {
            throw new Error(`form_submissions update failed: ${upd.error.message}`);
          }
        }

        // Sync into Resinaro CRM (this is part of the operational workflow).
        await notifyResinaroCrm({
          eventId: event.id,
          eventType: event.type,
          site,
          formSlug: formSlug ?? null,
          pricingTier: pricingTier ?? null,
          formSubmissionId: formSubmissionId ?? null,
          paymentIntentId: pi.id,
          amountCents,
          currency: currencyRaw,
          receiptEmail: typeof pi.receipt_email === "string" ? pi.receipt_email : null,
          metadata,
        });

        await markStripeEventStatus(event.id, "succeeded", null);

        return {
          ok: true,
          handled: true,
          paymentId: paymentRow.id,
          deduped: !claim.inserted,
        };
      }

      default: {
        // We intentionally ignore unknown types but still mark the event as processed.
        await markStripeEventStatus(event.id, "succeeded", null);
        return { ok: true, handled: false, deduped: !claim.inserted };
      }
    }
  } catch (err: unknown) {
    const message = errMsg(err);

    log("error", {
      msg: "stripe_event_processing_failed",
      eventId: event.id,
      type: event.type,
      error: message,
    });

    // Best effort mark failed (don’t swallow original error)
    try {
      await markStripeEventStatus(event.id, "failed", message);
    } catch (markErr: unknown) {
      log("error", {
        msg: "stripe_event_mark_failed_failed",
        eventId: event.id,
        error: errMsg(markErr),
      });
    }

    throw err; // bubble so webhook returns 5xx and Stripe retries
  }
}
