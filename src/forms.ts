import { supabase } from "./supabaseClient";

export type FormSubmissionStatus =
  | "new"
  | "pending_payment"
  | "converted"
  | "spam"
  | "error";

export interface FormSubmissionInput {
  site: string; // e.g. "resinaro", "saltaireguide"
  formSlug: string; // e.g. "passport_service", "free_listing"
  email?: string | null;
  name?: string | null;
  phone?: string | null;
  sourceUrl?: string | null;

  payload?: Record<string, unknown> | null;

  /**
   * Optional idempotency key for the submission itself.
   * (Recommended for paid flows, useful for dedupe.)
   */
  submissionKey?: string | null;

  /**
   * Let caller choose initial state (free vs paid).
   * Defaults to "new".
   */
  status?: FormSubmissionStatus;
}

type FormSubmissionRow = Record<string, any>;

function cleanString(v: unknown, max = 255): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max) : s;
}

function cleanPayload(p: unknown): Record<string, unknown> | null {
  if (!p || typeof p !== "object") return null;
  if (Array.isArray(p)) return null;
  // shallow clone to avoid weird prototypes
  return { ...(p as Record<string, unknown>) };
}

function assert(condition: unknown, msg: string): asserts condition {
  if (!condition) throw new Error(msg);
}

/**
 * Insert one form submission into form_submissions.
 *
 * DB recommendations (for “real” reliability):
 * - Add UNIQUE(site, form_slug, submission_key) WHERE submission_key IS NOT NULL
 *   so paid flow retries don't create duplicates.
 */
export async function createFormSubmission(
  input: FormSubmissionInput
): Promise<FormSubmissionRow> {
  const site = cleanString(input.site, 32);
  const formSlug = cleanString(input.formSlug, 64);

  assert(site, "site is required");
  assert(formSlug, "formSlug is required");

  const row = {
    site,
    form_slug: formSlug,
    email: cleanString(input.email, 254),
    name: cleanString(input.name, 120),
    phone: cleanString(input.phone, 32),
    source_url: cleanString(input.sourceUrl, 2048),
    payload: cleanPayload(input.payload),
    submission_key: cleanString(input.submissionKey, 128),
    status: input.status ?? "new",
    updated_at: new Date().toISOString(),
  };

  // If submission_key is provided, upsert (idempotent)
  // Requires a unique constraint on (site, form_slug, submission_key)
  const useUpsert = !!row.submission_key;

  const query = useUpsert
    ? supabase
        .from("form_submissions")
        .upsert(row as any, { onConflict: "site,form_slug,submission_key" })
        .select()
        .single()
    : supabase.from("form_submissions").insert(row as any).select().single();

  const { data, error } = await query;

  if (error) {
    console.error("form_submissions write error:", {
      message: error.message,
      details: (error as any).details,
      hint: (error as any).hint,
      code: (error as any).code,
      site,
      formSlug,
      hasSubmissionKey: !!row.submission_key,
    });
    throw new Error("Failed to write form submission");
  }

  return data as FormSubmissionRow;
}
