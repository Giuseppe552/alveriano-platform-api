import { createHash, randomUUID } from "crypto";
import { z } from "zod";
import { createFormSubmission, type FormSubmissionInput } from "../forms";
import { stripe } from "../stripeClient";
import { APP_ENV } from "../env";

/**
 * Paid form submissions are security-sensitive.
 * Client input is untrusted. Pricing is ALWAYS determined server-side.
 */

export interface PaidFormPaymentInfo {
  amountCents: number;
  currency: string;
  description: string;
}

export interface SubmitPaidFormRequestBody extends FormSubmissionInput {
  payment: PaidFormPaymentInfo; // required for backwards-compat (UI can still send it)
  idempotencyKey?: string | null;
}

export interface SubmitPaidFormResult {
  submissionId: string;
  clientSecret: string;
  amountCents: number;
  currency: string;
  description?: string;
}

/** Typed error that apiHandler can map to HTTP correctly */
class SubmitPaidFormError extends Error {
  public readonly statusCode: number;
  public readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = "SubmitPaidFormError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

const MAX_IDEMPOTENCY_KEY_LEN = 128;
const MAX_METADATA_LEN = 120;

/**
 * Canonical pricing catalog (server truth).
 *
 * Add every paid form here. If it’s not here, it’s not payable in prod.
 * This prevents “£0.01 for £499 service” attacks.
 *
 * Structure:
 * { [site]: { [formSlug]: { amountCents, currency, description } } }
 */
const PAID_FORM_CATALOG: Record<
  string,
  Record<
    string,
    {
      amountCents: number;
      currency: string;
      description: string;
    }
  >
> = {
  // EXAMPLES (replace with your real paid offerings)
  // resinaro: {
  //   passport_service: { amountCents: 4999, currency: "gbp", description: "Resinaro: Passport service" },
  // },
  // saltaireguide: {
  //   featured_listing: { amountCents: 3000, currency: "gbp", description: "SaltaireGuide: Featured listing" },
  // },
};

function cleanStr(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s.length ? s : null;
}

function clampMetadata(v: unknown): string | null {
  const s = cleanStr(v);
  if (!s) return null;
  return s.length > MAX_METADATA_LEN ? s.slice(0, MAX_METADATA_LEN) : s;
}

function stableStringify(value: unknown): string {
  // Deterministic stringify for idempotency hashing
  const seen = new WeakSet<object>();

  const rec = (v: unknown): unknown => {
    if (v === null) return null;
    if (typeof v !== "object") return v;
    if (seen.has(v as object)) return "[circular]";
    seen.add(v as object);

    if (Array.isArray(v)) return v.map(rec);

    const o = v as Record<string, unknown>;
    const keys = Object.keys(o).sort();
    const out: Record<string, unknown> = {};
    for (const k of keys) out[k] = rec(o[k]);
    return out;
  };

  return JSON.stringify(rec(value));
}

function sha256Base64Url(input: string): string {
  const buf = createHash("sha256").update(input).digest();
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function normalizeCurrency(v: string): string {
  return v.trim().toLowerCase();
}

function normalizeIdempotencyKey(v: unknown): string | null {
  const s = cleanStr(v);
  if (!s) return null;

  // Stripe idempotency key: max 255 chars, but we keep it tighter.
  if (s.length > MAX_IDEMPOTENCY_KEY_LEN) {
    throw new SubmitPaidFormError(
      400,
      "IDEMPOTENCY_KEY_TOO_LONG",
      `idempotencyKey must be <= ${MAX_IDEMPOTENCY_KEY_LEN} chars`
    );
  }

  // Restrict chars to avoid log weirdness / header injection edge cases.
  if (!/^[a-zA-Z0-9:_-]+$/.test(s)) {
    throw new SubmitPaidFormError(
      400,
      "IDEMPOTENCY_KEY_INVALID",
      "idempotencyKey contains invalid characters"
    );
  }

  return s;
}

/**
 * Pricing resolver (server truth).
 * In non-local envs: if it’s not in catalog, hard fail.
 * In local: allow fallback for rapid iteration (still validated & bounded).
 */
function resolvePricing(args: {
  site: string;
  formSlug: string;
  clientPayment: PaidFormPaymentInfo;
}): { amountCents: number; currency: string; description: string } {
  const { site, formSlug, clientPayment } = args;

  const entry = PAID_FORM_CATALOG?.[site]?.[formSlug];
  if (entry) {
    return {
      amountCents: entry.amountCents,
      currency: normalizeCurrency(entry.currency),
      description: entry.description,
    };
  }

  // Local-only escape hatch. NEVER allow arbitrary pricing in dev/staging/prod.
  if (APP_ENV === "local") {
    return {
      amountCents: clientPayment.amountCents,
      currency: normalizeCurrency(clientPayment.currency),
      description: clientPayment.description,
    };
  }

  throw new SubmitPaidFormError(
    500,
    "PRICING_NOT_CONFIGURED",
    `Paid pricing not configured for ${site}/${formSlug}`
  );
}

/**
 * Validate request input. (This is the business-layer guardrail.)
 * Your HTTP layer should ALSO validate, but this ensures safety even if routing changes.
 */
const SubmitPaidFormSchema = z.object({
  site: z.string().trim().min(1).max(32),
  formSlug: z.string().trim().min(1).max(64),

  email: z.string().trim().email().max(254).optional(),
  name: z.string().trim().min(1).max(120).optional(),
  phone: z.string().trim().min(3).max(40).optional(),

  sourceUrl: z.string().trim().url().max(2048).optional(),

  payload: z.record(z.string(), z.unknown()).optional(),

  payment: z.object({
    // Client-provided values are NOT trusted; but we validate them so the UI doesn’t send garbage.
    amountCents: z.number().int().nonnegative().max(10_000_00), // cap at 10,000.00 (edit to your needs)
    currency: z.string().trim().min(3).max(8),
    description: z.string().trim().min(1).max(300),
  }),

  idempotencyKey: z.string().trim().max(MAX_IDEMPOTENCY_KEY_LEN).optional(),
});

function buildIdempotencyKey(input: {
  site: string;
  formSlug: string;
  email?: string | undefined;
  sourceUrl?: string | undefined;
  payload?: Record<string, unknown> | undefined;
  provided?: string | null | undefined;
}): string {
  const provided = normalizeIdempotencyKey(input.provided);
  if (provided) return provided;

  // Deterministic key so retries create the same PaymentIntent.
  // Include only stable fields; avoid phone/name (can differ per retry).
  const basis = stableStringify({
    v: 1,
    site: input.site,
    formSlug: input.formSlug,
    email: input.email ?? null,
    sourceUrl: input.sourceUrl ?? null,
    payload: input.payload ?? null,
  });

  // Prefix helps debugging in Stripe dashboard.
  return `sf_${sha256Base64Url(basis).slice(0, 48)}`;
}

export async function handleSubmitPaidForm(
  body: SubmitPaidFormRequestBody
): Promise<SubmitPaidFormResult> {
  const parsed = SubmitPaidFormSchema.safeParse(body);
  if (!parsed.success) {
    throw new SubmitPaidFormError(
      400,
      "INVALID_REQUEST",
      parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
    );
  }

  const {
    site,
    formSlug,
    email,
    name,
    phone,
    sourceUrl,
    payload,
    payment: clientPayment,
  } = parsed.data;

  // Resolve canonical server pricing (client can’t control it)
  const pricing = resolvePricing({ site, formSlug, clientPayment });

  // Optional: if the UI sent a different amount, reject (prevents confused UI / stale pricing)
  const clientCurrency = normalizeCurrency(clientPayment.currency);
  if (
    APP_ENV !== "local" &&
    (clientPayment.amountCents !== pricing.amountCents ||
      clientCurrency !== pricing.currency)
  ) {
    throw new SubmitPaidFormError(
      400,
      "PRICE_MISMATCH",
      "Client pricing does not match server pricing"
    );
  }

  const submissionKey = buildIdempotencyKey({
    site,
    formSlug,
    email,
    sourceUrl,
    payload: payload ?? undefined,
    provided: body.idempotencyKey ?? null,
  });

  // 1) Create the form submission (DB truth)
  // NOTE: This should be idempotent in DB via a UNIQUE constraint on submission_key (recommended).
  const submission = await createFormSubmission({
    site,
    formSlug,
    email: email ?? null,
    name: name ?? null,
    phone: phone ?? null,
    sourceUrl: sourceUrl ?? null,
    payload: payload ?? null,

    // If your forms.ts supports these fields (it looks like it does in your repo):
    status: "pending_payment",
    submissionKey,
  } as any); // keep as any until your forms.ts types are strict for these columns

  const submissionId = submission["id"] as string;
  if (!submissionId) {
    throw new SubmitPaidFormError(500, "DB_ERROR", "Submission insert returned no id");
  }

  // 2) Create Stripe PaymentIntent with STRONG idempotency
  // Use a derived key so PI creation is idempotent even if Lambda retries.
  const stripeIdempotencyKey = `pi_${submissionKey}`;

  const paymentIntent = await stripe.paymentIntents.create(
    {
      amount: pricing.amountCents,
      currency: pricing.currency,
      description: pricing.description,

      // Receipt email if present (safe, validated)
      ...(email ? { receipt_email: email } : {}),

      // Metadata must be short strings. Do not dump payload/PII.
      metadata: {
        app_env: APP_ENV,
        site: clampMetadata(site),
        form_slug: clampMetadata(formSlug),
        form_submission_id: clampMetadata(submissionId),
        submission_key: clampMetadata(submissionKey),
      },

      automatic_payment_methods: { enabled: true },
    },
    { idempotencyKey: stripeIdempotencyKey }
  );
  
  if (!paymentIntent.client_secret) {
    throw new SubmitPaidFormError(
      502,
      "STRIPE_NO_CLIENT_SECRET",
      "Stripe did not return a client_secret"
    );
  }

  return {
    submissionId,
    clientSecret: paymentIntent.client_secret,
    amountCents: paymentIntent.amount,
    currency: paymentIntent.currency,
    description: paymentIntent.description ?? pricing.description,
  };
}
