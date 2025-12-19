import { supabase } from "./supabaseClient";

export type Currency = "gbp" | "eur" | "usd";

export type PaymentStatus =
  | "succeeded"
  | "failed"
  | "refunded"
  | "processing"
  | "requires_action";

export interface PaymentRecordInput {
  site: string;
  formSubmissionId?: string | null;

  amountCents: number;
  currency: Currency;

  // At least one of these must be provided for idempotency
  stripePaymentIntentId?: string | null;
  stripeCheckoutSessionId?: string | null;

  stripeCustomerId?: string | null;
  status: PaymentStatus;

  /**
   * Minimal JSON snapshot only.
   * Keep this small; do NOT store full Stripe events unless you must.
   */
  rawEvent?: Record<string, unknown> | null;
}

/**
 * What we actually rely on returning.
 * Don’t use `any` for money.
 */
export interface PaymentRow {
  id: string;
  site: string;
  form_submission_id: string | null;
  amount_cents: number;
  currency: Currency;
  stripe_payment_intent_id: string | null;
  stripe_checkout_session_id: string | null;
  stripe_customer_id: string | null;
  status: PaymentStatus;
  updated_at?: string;
  created_at?: string;
}

function cleanString(v: unknown, max = 255): string {
  if (typeof v !== "string") return "";
  const s = v.trim();
  if (!s) return "";
  return s.length > max ? s.slice(0, max) : s;
}

function assert(condition: unknown, msg: string): asserts condition {
  if (!condition) throw new Error(msg);
}

function clampJson(obj: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!obj) return null;
  // very simple size guard: limit serialized bytes
  // (Postgres JSONB can handle large, but you don't want Stripe blobs here)
  const json = JSON.stringify(obj);
  const MAX_BYTES = 12_000; // keep it small
  if (Buffer.byteLength(json, "utf8") > MAX_BYTES) {
    return { truncated: true, note: "rawEvent exceeded size limit" };
  }
  return obj;
}

/**
 * Create a payment record idempotently.
 *
 * DB REQUIREMENTS (REAL, not optional):
 * - payments.stripe_payment_intent_id UNIQUE WHERE NOT NULL
 * - payments.stripe_checkout_session_id UNIQUE WHERE NOT NULL
 */
export async function createPaymentRecord(input: PaymentRecordInput): Promise<PaymentRow> {
  const site = cleanString(input.site, 32) || "unknown";

  assert(Number.isFinite(input.amountCents), "amountCents must be a finite number");
  assert(Number.isInteger(input.amountCents), "amountCents must be an integer");
  assert(input.amountCents > 0, "amountCents must be > 0");

  // enforce restricted currency at compile time (Currency union)
  const currency = input.currency;

  const stripePaymentIntentId = cleanString(input.stripePaymentIntentId ?? "", 128);
  const stripeCheckoutSessionId = cleanString(input.stripeCheckoutSessionId ?? "", 128);

  assert(
    stripePaymentIntentId.length > 0 || stripeCheckoutSessionId.length > 0,
    "createPaymentRecord requires stripePaymentIntentId or stripeCheckoutSessionId"
  );

  // If both are present, prefer PI and still store both safely.
  const onConflict =
    stripePaymentIntentId.length > 0 ? "stripe_payment_intent_id" : "stripe_checkout_session_id";

  const row = {
    site,
    form_submission_id: input.formSubmissionId ?? null,
    amount_cents: input.amountCents,
    currency,
    stripe_payment_intent_id: stripePaymentIntentId || null,
    stripe_checkout_session_id: stripeCheckoutSessionId || null,
    stripe_customer_id: input.stripeCustomerId ? cleanString(input.stripeCustomerId, 128) : null,
    status: input.status,
    raw_event: clampJson(input.rawEvent),
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from("payments")
    .upsert(row as any, { onConflict })
    .select(
      "id, site, form_submission_id, amount_cents, currency, stripe_payment_intent_id, stripe_checkout_session_id, stripe_customer_id, status, created_at, updated_at"
    )
    .single();

  if (error) {
    console.error("payments upsert error:", {
      message: error.message,
      details: (error as any).details,
      hint: (error as any).hint,
      code: (error as any).code,
      onConflict,
      stripePaymentIntentId: stripePaymentIntentId || null,
      stripeCheckoutSessionId: stripeCheckoutSessionId || null,
    });
    throw new Error("Failed to write payment record");
  }

  return data as PaymentRow;
}
