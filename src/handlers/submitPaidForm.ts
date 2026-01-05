// src/handlers/submitPaidForm.ts
import { createHash } from "crypto";
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
 * Supports:
 * - fixed pricing per (site, formSlug)
 * - tiered pricing per (site, formSlug) keyed by payload field (default: payload.choice)
 */

type FixedPricing = {
  type: "fixed";
  amountCents: number;
  currency: string;
  description: string;
};

type TieredPricing = {
  type: "tiered";
  currency: string;
  /**
   * Which payload key selects the tier (default "choice").
   * Your Resinaro passport flow uses payload.choice = "ap-1" | "ap-2" | "ap-3".
   */
  tierKey?: string;
  tiers: Record<
    string,
    {
      amountCents: number;
      description: string;
    }
  >;
};

type PricingEntry = FixedPricing | TieredPricing;

const PAID_FORM_CATALOG: Record<string, Record<string, PricingEntry>> = {
  resinaro: {
    /**
     * Resinaro passport appointment (12+): tiered by payload.choice
     * MUST match your Next.js route.ts:
     *   const FORM_SLUG = "passport_appointment_12plus"
     *   payload.choice: "ap-1" | "ap-2" | "ap-3"
     */
    passport_appointment_12plus: {
      type: "tiered",
      currency: "gbp",
      tierKey: "choice",
      tiers: {
        "ap-1": {
          amountCents: 4000,
          description: "Resinaro — Italian passport appointment (12+) — AP-1",
        },
        "ap-2": {
          amountCents: 7800,
          description: "Resinaro — Italian passport appointment (12+) — AP-2",
        },
        "ap-3": {
          amountCents: 11500,
          description: "Resinaro — Italian passport appointment (12+) — AP-3",
        },
      },
    },

    /**
     * Resinaro certified translation: tiered by payload.pageBand
     * payload.pageBand: "1" | "2" | "3" | "4"
     */
    translation_certified: {
      type: "tiered",
      currency: "gbp",
      tierKey: "pageBand",
      tiers: {
        "1": {
          amountCents: 1800,
          description: "1 page certified translation (+ signed declaration + UK 48h post) — Resinaro",
        },
        "2": {
          amountCents: 2400,
          description: "2 pages certified translation (+ signed declaration + UK 48h post) — Resinaro",
        },
        "3": {
          amountCents: 2600,
          description: "3 pages certified translation (+ signed declaration + UK 48h post) — Resinaro",
        },
        "4": {
          amountCents: 3000,
          description: "4 pages certified translation (+ signed declaration + UK 48h post) — Resinaro",
        },
      },
    },

    /**
     * Resinaro family travel check: fixed price
     */
    family_travel_check: {
      type: "fixed",
      amountCents: 500,
      currency: "gbp",
      description: "Family Travel Quick Check (UK → Italy) — Resinaro",
    },

    /**
     * Resinaro citizenship by descent: tiered by payload.service
     * payload.service: "guide" | "121"
     */
    citizenship_descent: {
      type: "tiered",
      currency: "gbp",
      tierKey: "service",
      tiers: {
        guide: {
          amountCents: 3500,
          description: "Italian citizenship by descent – £35 written guide (Resinaro)",
        },
        "121": {
          amountCents: 17000,
          description: "Italian citizenship by descent – £170 1:1 support (Resinaro)",
        },
      },
    },

    /**
     * Resinaro citizenship by marriage: tiered by payload.option
     * payload.option: "guide-35" | "check-170"
     */
    citizenship_by_marriage: {
      type: "tiered",
      currency: "gbp",
      tierKey: "option",
      tiers: {
        "guide-35": {
          amountCents: 3500,
          description: "Italian citizenship by marriage guide (UK) — Resinaro",
        },
        "check-170": {
          amountCents: 17000,
          description: "Italian citizenship by marriage 1:1 document & plan check (UK) — Resinaro",
        },
      },
    },

    /**
     * Resinaro citizenship language check: fixed price
     */
    citizenship_language_check: {
      type: "fixed",
      amountCents: 5000,
      currency: "gbp",
      description: "Citizenship Route & Language Strategy Mini-Review — Resinaro",
    },

    /**
     * Resinaro visa assistance: tiered by payload.option
     * payload.option: "intake-35" | "full-70"
     */
    visa_assistance: {
      type: "tiered",
      currency: "gbp",
      tierKey: "option",
      tiers: {
        "intake-35": {
          amountCents: 3500,
          description: "Visa assistance intake consultation (UK) — Resinaro",
        },
        "full-70": {
          amountCents: 7000,
          description: "Visa assistance full service (UK) — Resinaro",
        },
      },
    },

    /**
     * Resinaro advertising packages: tiered by payload.choice
     * payload.choice: "dir-basic" | "dir-premium" | "web-5" | "web-audit" | "web-50"
     */
    advertise_package: {
      type: "tiered",
      currency: "gbp",
      tierKey: "choice",
      tiers: {
        "dir-basic": {
          amountCents: 1000,
          description: "Resinaro — basic directory listing (first month)",
        },
        "dir-premium": {
          amountCents: 6000,
          description: "Resinaro — premium directory listing (first month)",
        },
        "web-5": {
          amountCents: 5000,
          description: "Resinaro — 5-page website build",
        },
        "web-audit": {
          amountCents: 7000,
          description: "Resinaro — SEO & conversion audit",
        },
        "web-50": {
          amountCents: 30000,
          description: "Resinaro — up to 50-page website build",
        },
      },
    },
  },

  // Add other paid forms here over time (fixed or tiered).
  // saltaireguide: {
  //   featured_listing: { type: "fixed", amountCents: 3000, currency: "gbp", description: "SaltaireGuide — Featured listing" },
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

function getPayloadTier(payload: Record<string, unknown> | undefined, tierKey: string): string | null {
  if (!payload) return null;
  return cleanStr(payload[tierKey]);
}

function getPayloadQty(payload: Record<string, unknown> | undefined): number | null {
  if (!payload) return null;
  const v = payload["qty"];
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  const n = Math.trunc(v);
  if (n < 1 || n > 10) return null;
  return n;
}

/**
 * Pricing resolver (server truth).
 * In non-local envs: if it’s not in catalog, hard fail.
 * In local: allow fallback for rapid iteration (still validated & bounded).
 */
function resolvePricing(args: {
  site: string;
  formSlug: string;
  payload?: Record<string, unknown> | undefined;
  clientPayment: PaidFormPaymentInfo;
}): { amountCents: number; currency: string; description: string; tier?: string | null } {
  const { site, formSlug, payload, clientPayment } = args;

  const entry = PAID_FORM_CATALOG?.[site]?.[formSlug];

  if (entry) {
    if (entry.type === "fixed") {
      return {
        amountCents: entry.amountCents,
        currency: normalizeCurrency(entry.currency),
        description: entry.description,
        tier: null,
      };
    }

    // tiered
    const tierKey = entry.tierKey ?? "choice";
    const tier = getPayloadTier(payload, tierKey);
    if (!tier) {
      throw new SubmitPaidFormError(
        400,
        "PRICING_INPUT_MISSING",
        `Missing payload.${tierKey} for ${site}/${formSlug}`
      );
    }

    const tierEntry = entry.tiers[tier];
    if (!tierEntry) {
      throw new SubmitPaidFormError(
        400,
        "PRICE_TIER_UNKNOWN",
        `Unknown pricing tier "${tier}" for ${site}/${formSlug}`
      );
    }

    // Optional: add qty to description (does NOT change amount)
    const qty = getPayloadQty(payload) ?? 1;
    const desc = qty > 1 ? `${tierEntry.description} (${qty} people)` : tierEntry.description;

    return {
      amountCents: tierEntry.amountCents,
      currency: normalizeCurrency(entry.currency),
      description: desc,
      tier,
    };
  }

  // Local-only escape hatch. NEVER allow arbitrary pricing in dev/staging/prod.
  if (APP_ENV === "local") {
    return {
      amountCents: clientPayment.amountCents,
      currency: normalizeCurrency(clientPayment.currency),
      description: clientPayment.description,
      tier: null,
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
  const pricing = resolvePricing({
    site,
    formSlug,
    payload: payload as Record<string, unknown> | undefined,
    clientPayment,
  });

  // Optional: if the UI sent a different amount/currency, reject (prevents stale UI / tampering)
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

    status: "pending_payment",
    submissionKey,
  } as any);

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

        // Useful for tiered pricing debugging (safe)
        pricing_tier: clampMetadata(pricing.tier ?? null),
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
