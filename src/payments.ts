import { z } from "zod";
import { supabase } from "./supabaseClient";

/**
 * Tight invariants to match DB constraints and avoid silent drift.
 * If you add currencies later, update BOTH DB + this enum.
 */
export const CurrencySchema = z.enum(["gbp", "eur", "usd"]);
export type Currency = z.infer<typeof CurrencySchema>;

export const PaymentStatusSchema = z.enum([
  "succeeded",
  "failed",
  "refunded",
  "processing",
  "requires_action",
]);
export type PaymentStatus = z.infer<typeof PaymentStatusSchema>;

const MAX_SITE_LEN = 32;
const MAX_STRIPE_ID_LEN = 128;
const MAX_RAW_EVENT_BYTES = 12_000;

// Minimal shape we rely on returning from DB.
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
  created_at?: string;
  updated_at?: string;
}

export interface PaymentRecordInput {
  site: string;
  formSubmissionId?: string | null;

  amountCents: number;
  currency: Currency;

  // At least one of these must be provided (DB constraint + idempotency)
  stripePaymentIntentId?: string | null;
  stripeCheckoutSessionId?: string | null;

  stripeCustomerId?: string | null;
  status: PaymentStatus;

  /**
   * Minimal JSON snapshot only.
   * Never store full Stripe events here.
   */
  rawEvent?: Record<string, unknown> | null;
}

/**
 * Stable error classes so upstream (webhook/http) can decide:
 * - 4xx vs 5xx
 * - retry behaviour
 * - alerting
 */
export class PaymentValidationError extends Error {
  public readonly code = "PAYMENT_VALIDATION_ERROR";
  constructor(message: string) {
    super(message);
    this.name = "PaymentValidationError";
  }
}

export class PaymentWriteError extends Error {
  public readonly code = "PAYMENT_WRITE_ERROR";
  constructor(message: string) {
    super(message);
    this.name = "PaymentWriteError";
  }
}

function cleanString(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max) : s;
}

function assert(condition: unknown, msg: string): asserts condition {
  if (!condition) throw new PaymentValidationError(msg);
}

/**
 * Stripe id format checks match the DB constraints we added.
 * If you loosen DB constraints, loosen these too (but don’t).
 */
function assertStripeFormats(input: {
  pi?: string | null;
  cs?: string | null;
  cus?: string | null;
}) {
  const { pi, cs, cus } = input;

  if (pi) assert(/^pi_[A-Za-z0-9]+$/.test(pi), "Invalid stripePaymentIntentId format");
  if (cs) assert(/^cs_[A-Za-z0-9]+$/.test(cs), "Invalid stripeCheckoutSessionId format");
  if (cus) assert(/^cus_[A-Za-z0-9]+$/.test(cus), "Invalid stripeCustomerId format");
}

function clampJson(
  obj: Record<string, unknown> | null | undefined
): Record<string, unknown> | null {
  if (!obj) return null;

  // Avoid prototype weirdness
  const safe: Record<string, unknown> = { ...obj };

  let json: string;
  try {
    json = JSON.stringify(safe);
  } catch {
    // Cycles or non-serializable values: store a minimal marker
    return { truncated: true, note: "rawEvent not serializable" };
  }

  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes <= MAX_RAW_EVENT_BYTES) return safe;

  // Deterministic truncation: keep only a few keys if too big
  // (Never store massive Stripe blobs)
  const keys = Object.keys(safe).slice(0, 12);
  const small: Record<string, unknown> = {};
  for (const k of keys) small[k] = safe[k];

  return {
    truncated: true,
    bytes,
    keptKeys: keys,
    snapshot: small,
  };
}

function isUniqueViolation(err: unknown): boolean {
  const e = err as any;
  // Postgres unique violation is 23505; supabase-js typically exposes error.code
  return String(e?.code ?? "") === "23505";
}

const PaymentRowSchema = z.object({
  id: z.string().min(1),
  site: z.string().min(1).max(MAX_SITE_LEN),
  form_submission_id: z.string().uuid().nullable(),
  amount_cents: z.number().int().nonnegative(),
  currency: CurrencySchema,
  stripe_payment_intent_id: z.string().nullable(),
  stripe_checkout_session_id: z.string().nullable(),
  stripe_customer_id: z.string().nullable(),
  status: PaymentStatusSchema,
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
});

const SELECT_COLS =
  "id, site, form_submission_id, amount_cents, currency, stripe_payment_intent_id, stripe_checkout_session_id, stripe_customer_id, status, created_at, updated_at";

/**
 * Create a payment record idempotently.
 *
 * DB REQUIREMENTS (non-negotiable):
 * - UNIQUE payments.stripe_payment_intent_id WHERE NOT NULL
 * - UNIQUE payments.stripe_checkout_session_id WHERE NOT NULL
 * - CHECK at least one of the two stripe ids exists
 */
export async function createPaymentRecord(
  input: PaymentRecordInput,
  ctx?: { requestId?: string; traceId?: string }
): Promise<PaymentRow> {
  // Runtime validate currency/status (TS types do not protect production)
  CurrencySchema.parse(input.currency);
  PaymentStatusSchema.parse(input.status);

  const site = cleanString(input.site, MAX_SITE_LEN) ?? "unknown";

  assert(Number.isFinite(input.amountCents), "amountCents must be finite");
  assert(Number.isInteger(input.amountCents), "amountCents must be an integer");
  assert(input.amountCents > 0, "amountCents must be > 0");

  const stripePaymentIntentId = cleanString(input.stripePaymentIntentId, MAX_STRIPE_ID_LEN);
  const stripeCheckoutSessionId = cleanString(
    input.stripeCheckoutSessionId,
    MAX_STRIPE_ID_LEN
  );
  const stripeCustomerId = cleanString(input.stripeCustomerId, MAX_STRIPE_ID_LEN);

  assert(
    !!stripePaymentIntentId || !!stripeCheckoutSessionId,
    "stripePaymentIntentId or stripeCheckoutSessionId is required"
  );

  assertStripeFormats({
    pi: stripePaymentIntentId,
    cs: stripeCheckoutSessionId,
    cus: stripeCustomerId,
  });

  // Normalize currency to lowercase (DB expects lower + 3 letters)
  const currency = input.currency.toLowerCase() as Currency;

  const row = {
    site,
    form_submission_id: input.formSubmissionId ?? null,
    amount_cents: input.amountCents,
    currency,
    stripe_payment_intent_id: stripePaymentIntentId ?? null,
    stripe_checkout_session_id: stripeCheckoutSessionId ?? null,
    stripe_customer_id: stripeCustomerId ?? null,
    status: input.status,
    raw_event: clampJson(input.rawEvent),
    updated_at: new Date().toISOString(),
  };

  /**
   * Idempotency strategy:
   * - Upsert on the "primary" stripe identifier we have.
   * - If that fails due to *other* unique index conflict (rare but real when both ids are provided),
   *   fallback to fetching by the other id and return it (or throw if mismatch).
   */
  const onConflict = stripePaymentIntentId
    ? "stripe_payment_intent_id"
    : "stripe_checkout_session_id";

  const upsertRes: { data: unknown; error: any } = await supabase
    .from("payments")
    .upsert(row as any, { onConflict })
    .select(SELECT_COLS)
    .single();

  if (!upsertRes.error && upsertRes.data) {
    return PaymentRowSchema.parse(upsertRes.data) as PaymentRow;
  }

  // Handle weird but important case: collision on the OTHER unique index
  // Example: upsert on PI, but CS duplicates a different row -> insert/update fails.
  const err = upsertRes.error;
  if (err && isUniqueViolation(err) && stripePaymentIntentId && stripeCheckoutSessionId) {
    // Try read by checkout session id. If it exists and matches PI, treat as idempotent success.
    const existing = await supabase
      .from("payments")
      .select(SELECT_COLS)
      .eq("stripe_checkout_session_id", stripeCheckoutSessionId)
      .maybeSingle();

    if (!existing.error && existing.data) {
      const parsed = PaymentRowSchema.parse(existing.data) as PaymentRow;
      if (parsed.stripe_payment_intent_id && parsed.stripe_payment_intent_id !== stripePaymentIntentId) {
        throw new PaymentWriteError(
          "Stripe identifiers conflict: checkout_session_id is linked to a different payment_intent_id"
        );
      }
      return parsed;
    }
  }

  // Operational logging: structured, no secrets, no raw payload
  console.error(
    JSON.stringify({
      msg: "payments_write_failed",
      requestId: ctx?.requestId ?? "unknown",
      traceId: ctx?.traceId ?? "unknown",
      onConflict,
      site,
      stripePaymentIntentId: stripePaymentIntentId ?? null,
      stripeCheckoutSessionId: stripeCheckoutSessionId ?? null,
      code: (err as any)?.code ?? null,
      message: err?.message ?? String(err),
      hint: (err as any)?.hint ?? null,
      details: (err as any)?.details ?? null,
    })
  );

  throw new PaymentWriteError("Failed to write payment record");
}
