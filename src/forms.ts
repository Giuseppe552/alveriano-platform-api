// src/forms.ts
import { z } from "zod";
import { supabase } from "./supabaseClient";

export type FormSubmissionStatus =
  | "new"
  | "pending_payment"
  | "converted"
  | "spam"
  | "error";

export interface FormSubmissionInput {
  site: string;
  formSlug: string;

  email?: string | null;
  name?: string | null;
  phone?: string | null;
  sourceUrl?: string | null;

  payload?: Record<string, unknown> | null;

  /**
   * Optional idempotency key for the submission itself.
   * If present, the DB MUST enforce uniqueness.
   */
  submissionKey?: string | null;

  /**
   * Caller can choose initial state.
   */
  status?: FormSubmissionStatus;
}

export type FormSubmissionRow = {
  id: string;
  site: string;
  form_slug: string;
  status: FormSubmissionStatus;
  submission_key: string | null;
  created_at?: string;
  updated_at?: string;
};

/**
 * Extended return type to expose idempotency outcome.
 * - deduped=false => row was inserted now
 * - deduped=true  => row already existed (unique violation path)
 */
export type FormSubmissionResult = FormSubmissionRow & {
  deduped: boolean;
};

class FormError extends Error {
  public readonly statusCode: number;
  public readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = "FormError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

const MAX_SITE_LEN = 32;
const MAX_FORM_SLUG_LEN = 64;
const MAX_EMAIL_LEN = 254;
const MAX_NAME_LEN = 120;
const MAX_PHONE_LEN = 32;
const MAX_SOURCE_URL_LEN = 2048;
const MAX_SUBMISSION_KEY_LEN = 128;

// Payload limits: keep this tight or you’ll regret it.
const MAX_PAYLOAD_BYTES = 32 * 1024; // 32KB
const MAX_PAYLOAD_KEYS = 200;

function byteLengthUtf8(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

function safeTrim(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s.length ? s : null;
}

function clamp(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

function sanitizeEmail(v: unknown): string | null {
  const s = safeTrim(v);
  if (!s) return null;
  return clamp(s.toLowerCase(), MAX_EMAIL_LEN);
}

function sanitizePhone(v: unknown): string | null {
  const s = safeTrim(v);
  if (!s) return null;
  return clamp(s, MAX_PHONE_LEN);
}

function sanitizeUrl(v: unknown): string | null {
  const s = safeTrim(v);
  if (!s) return null;
  const trimmed = clamp(s, MAX_SOURCE_URL_LEN);
  try {
    // If invalid, we reject. Don’t store garbage.
    new URL(trimmed);
  } catch {
    throw new FormError(400, "INVALID_SOURCE_URL", "sourceUrl must be a valid URL");
  }
  return trimmed;
}

function sanitizePayload(v: unknown): Record<string, unknown> | null {
  if (v == null) return null;
  if (typeof v !== "object" || Array.isArray(v)) {
    throw new FormError(400, "INVALID_PAYLOAD", "payload must be a JSON object");
  }

  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj);

  if (keys.length > MAX_PAYLOAD_KEYS) {
    throw new FormError(
      413,
      "PAYLOAD_TOO_LARGE",
      `payload has too many keys (max ${MAX_PAYLOAD_KEYS})`
    );
  }

  // Strip prototypes/weirdness + ensure JSON-serializable
  let json: string;
  try {
    json = JSON.stringify(obj);
  } catch {
    throw new FormError(400, "INVALID_PAYLOAD", "payload must be JSON-serializable");
  }

  if (byteLengthUtf8(json) > MAX_PAYLOAD_BYTES) {
    throw new FormError(
      413,
      "PAYLOAD_TOO_LARGE",
      `payload exceeds ${MAX_PAYLOAD_BYTES} bytes`
    );
  }

  // Parse back to ensure it's plain JSON (no weird prototypes)
  return JSON.parse(json) as Record<string, unknown>;
}

const InputSchema = z.object({
  site: z.string().trim().min(1).max(MAX_SITE_LEN),
  formSlug: z.string().trim().min(1).max(MAX_FORM_SLUG_LEN),

  email: z.string().trim().max(MAX_EMAIL_LEN).optional().nullable(),
  name: z.string().trim().max(MAX_NAME_LEN).optional().nullable(),
  phone: z.string().trim().max(MAX_PHONE_LEN).optional().nullable(),
  sourceUrl: z.string().trim().max(MAX_SOURCE_URL_LEN).optional().nullable(),

  payload: z.record(z.string(), z.unknown()).optional().nullable(),

  submissionKey: z.string().trim().max(MAX_SUBMISSION_KEY_LEN).optional().nullable(),
  status: z.enum(["new", "pending_payment", "converted", "spam", "error"]).optional(),
});

function isUniqueViolation(err: any): boolean {
  // Postgres unique violation is 23505
  return String(err?.code) === "23505";
}

/**
 * Create a form submission.
 *
 * Idempotency behaviour:
 * - If submissionKey is provided:
 *   - attempt INSERT
 *   - on duplicate, SELECT existing and return it (no overwrites)
 *
 * This requires a DB unique constraint/index on:
 *   (site, form_slug, submission_key) WHERE submission_key IS NOT NULL
 */
export async function createFormSubmission(
  input: FormSubmissionInput
): Promise<FormSubmissionResult> {
  const parsed = InputSchema.safeParse(input);
  if (!parsed.success) {
    throw new FormError(
      400,
      "INVALID_REQUEST",
      parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
    );
  }

  const site = parsed.data.site;
  const formSlug = parsed.data.formSlug;

  const submissionKey = parsed.data.submissionKey
    ? clamp(parsed.data.submissionKey, MAX_SUBMISSION_KEY_LEN)
    : null;

  const row = {
    site,
    form_slug: formSlug,

    // Sanitise PII, but DO NOT LOG IT anywhere in this module.
    email: sanitizeEmail(parsed.data.email),
    name: parsed.data.name ? clamp(parsed.data.name.trim(), MAX_NAME_LEN) : null,
    phone: sanitizePhone(parsed.data.phone),
    source_url: parsed.data.sourceUrl ? sanitizeUrl(parsed.data.sourceUrl) : null,

    payload: sanitizePayload(parsed.data.payload),

    submission_key: submissionKey,
    status: parsed.data.status ?? "new",

    updated_at: new Date().toISOString(),
  };

  // Return only what we actually need
  const selectCols = "id, site, form_slug, status, submission_key, created_at, updated_at";

  // Idempotent path (insert-first; on duplicate, fetch existing)
  if (submissionKey) {
    const ins: any = await supabase
      .from("form_submissions")
      .insert(row as any)
      .select(selectCols)
      .single();

    if (!ins.error && ins.data) {
      return { ...(ins.data as FormSubmissionRow), deduped: false };
    }

    if (ins.error && isUniqueViolation(ins.error)) {
      const { data: existingData, error: existingError } = await supabase
        .from("form_submissions")
        .select(selectCols)
        .eq("site", site)
        .eq("form_slug", formSlug)
        .eq("submission_key", submissionKey)
        .single();

      if (existingError || !existingData) {
        // If we can't read the existing row, treat as infra failure.
        // This should trigger retry upstream.
        throw new FormError(
          500,
          "DB_READ_FAILED",
          "Failed to fetch existing form submission after unique conflict"
        );
      }

      return { ...(existingData as FormSubmissionRow), deduped: true };
    }

    // Non-unique DB error
    console.error("form_submissions insert failed", {
      code: ins.error?.code,
      message: ins.error?.message,
      hint: (ins.error as any)?.hint,
      // NO PII. Only structural context:
      site,
      formSlug,
      hasSubmissionKey: true,
    });

    throw new FormError(500, "DB_WRITE_FAILED", "Failed to write form submission");
  }

  // Non-idempotent path (simple insert)
  const { data, error } = await supabase
    .from("form_submissions")
    .insert(row as any)
    .select(selectCols)
    .single();

  if (error || !data) {
    console.error("form_submissions insert failed", {
      code: error?.code,
      message: error?.message,
      hint: (error as any)?.hint,
      site,
      formSlug,
      hasSubmissionKey: false,
    });
    throw new FormError(500, "DB_WRITE_FAILED", "Failed to write form submission");
  }

  return { ...(data as FormSubmissionRow), deduped: false };
}
