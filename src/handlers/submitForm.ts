// src/handlers/submitForm.ts
import { z } from "zod";
import { createFormSubmission } from "../forms";

/**
 * If you add new sites, add them here.
 * Rejecting unknown sites is a simple anti-spam / data-quality gate.
 */
const ALLOWED_SITES = new Set([
  "resinaro",
  "saltaireguide",
  "saltaire-guide",
  "giuseppefood",
  "giuseppe-food",
  "giuseppe.food",
  "alveriano",
]);

/**
 * Error type that the HTTP layer can treat as a 4xx.
 * (Update apiHandler to respect err.statusCode, see note below.)
 */
export class BadRequestError extends Error {
  public readonly statusCode = 400;
  public readonly code = "bad_request";
  public readonly details?: unknown;

  constructor(message: string, details?: unknown) {
    super(message);
    this.name = "BadRequestError";
    this.details = details;
  }
}

const EmailSchema = z
  .string()
  .trim()
  .min(3)
  .max(254)
  .email()
  .transform((v) => v.toLowerCase());

const SiteSchema = z
  .string()
  .trim()
  .min(2)
  .max(32)
  .regex(/^[a-z0-9.-]+$/i, "Invalid site format")
  .transform((v) => v.toLowerCase());

const FormSlugSchema = z
  .string()
  .trim()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9/_-]+$/i, "Invalid formSlug format");

const UrlSchema = z
  .string()
  .trim()
  .max(2048)
  .url()
  .refine(
    (u) => u.startsWith("https://") || u.startsWith("http://"),
    "Invalid URL scheme"
  );

const PhoneSchema = z
  .string()
  .trim()
  .min(6)
  .max(32)
  // relaxed: allows +, spaces, (), hyphens
  .regex(/^[0-9+() -]+$/, "Invalid phone format");

const PayloadSchema = z.record(z.string(), z.unknown()).optional().default({});

/**
 * Idempotency key (frontend can send this).
 * IMPORTANT:
 * - forms.ts clamps/validates again, but we validate here to keep errors clean and client-friendly.
 * - keep permissive: only length + trimming. Do NOT over-regex this unless you want random rejects.
 */
const SubmissionKeySchema = z.string().trim().min(8).max(128).optional();

function safeTrimString(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s.length ? s : null;
}

function getPayloadString(
  payload: Record<string, unknown> | undefined,
  key: string
): string | null {
  if (!payload) return null;
  return safeTrimString(payload[key]);
}

/**
 * Strict request schema for POST /forms/submit
 *
 * Note: If you want to allow extra fields temporarily, remove `.strict()`.
 */
export const SubmitFormSchema = z
  .object({
    site: SiteSchema,
    formSlug: FormSlugSchema,

    // NEW: allow top-level idempotency key (preferred)
    submissionKey: SubmissionKeySchema,

    email: EmailSchema.optional(),
    name: z.string().trim().max(120).optional(),
    phone: PhoneSchema.optional(),

    sourceUrl: UrlSchema.optional(),

    // Arbitrary form data
    payload: PayloadSchema,

    // Optional anti-spam honeypot (frontend can send this hidden)
    hp: z.string().optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    // Basic anti-spam: honeypot must be empty if present
    if (data.hp && data.hp.trim() !== "") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Rejected",
        path: ["hp"],
      });
    }

    // Require at least one contact method (email or phone)
    const hasEmail = typeof data.email === "string" && data.email.length > 0;
    const hasPhone = typeof data.phone === "string" && data.phone.length > 0;
    if (!hasEmail && !hasPhone) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide at least one contact method (email or phone)",
        path: ["email"],
      });
    }

    // Backwards compatibility: some clients may place submissionKey inside payload.
    // If BOTH exist and mismatch, reject (prevents weird duplication/poisoning).
    const payloadKey = getPayloadString(data.payload, "submissionKey");
    const topKey = safeTrimString(data.submissionKey);

    if (topKey && payloadKey && topKey !== payloadKey) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "submissionKey mismatch",
        path: ["submissionKey"],
      });
    }
  });

export type SubmitFormRequestBody = z.infer<typeof SubmitFormSchema>;

export interface SubmitFormResult {
  submissionId: string;
  deduped: boolean;
}

/**
 * Core logic for "POST /forms/submit" (unpaid forms).
 * Accepts unknown input, validates it, then writes to DB.
 */
export async function handleSubmitForm(
  input: unknown
): Promise<SubmitFormResult> {
  const parsed = SubmitFormSchema.safeParse(input);
  if (!parsed.success) {
    const details = parsed.error.flatten();
    throw new BadRequestError("Invalid request body", details);
  }

  const body = parsed.data;

  // Hard allowlist for site (data quality + anti-spam)
  if (!ALLOWED_SITES.has(body.site)) {
    throw new BadRequestError("Invalid site");
  }

  // Final idempotency key resolution:
  // - Prefer top-level submissionKey
  // - Fallback to payload.submissionKey for older clients
  const submissionKey =
    safeTrimString(body.submissionKey) ??
    getPayloadString(body.payload, "submissionKey") ??
    null;

  /**
   * IMPORTANT:
   * - DB idempotency requires a unique constraint/index on (site, form_slug, submission_key) where submission_key is not null.
   * - This handler can only report `deduped=true` if `createFormSubmission()` attaches a boolean flag to the returned object,
   *   e.g. `return { ...row, deduped }` (recommended).
   */
  const submission: any = await createFormSubmission({
    site: body.site,
    formSlug: body.formSlug,
    email: body.email ?? null,
    name: body.name ?? null,
    phone: body.phone ?? null,
    sourceUrl: body.sourceUrl ?? null,
    payload: body.payload,
    submissionKey, // enables DB idempotency behaviour in forms.ts
  });

  const submissionId = submission?.id as string | undefined;
  if (!submissionId) {
    throw new Error("createFormSubmission returned no id");
  }

  // Will be true only after you add the small companion change in forms.ts (next step).
  const deduped = submission?.deduped === true;

  return { submissionId, deduped };
}
