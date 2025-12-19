import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { config } from "./env";

/**
 * Minimal “no-any” DB type placeholder.
 * Best practice: replace with generated types from Supabase when ready.
 */
type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json }
  | Json[];

type DbTable = {
  Row: Record<string, Json>;
  Insert: Record<string, Json>;
  Update: Record<string, Json>;
  Relationships: unknown[];
};

type Database = {
  public: {
    Tables: Record<string, DbTable>;
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, string>;
    CompositeTypes: Record<string, never>;
  };
};

/**
 * Hard guard: this module must never run in a browser bundle.
 * If you ever move code around and accidentally import this client-side,
 * it should fail loudly rather than leak a service role key.
 */
function assertServerOnly(): void {
  // In browser-like contexts, globalThis.window exists
  if (typeof globalThis !== "undefined" && (globalThis as { window?: unknown }).window) {
    throw new Error(
      "SECURITY: supabaseClient (service role) imported in a browser context."
    );
  }
}

assertServerOnly();

function assertFetchAvailable(): void {
  if (typeof fetch !== "function") {
    throw new Error("Global fetch() is not available. Use Node 18+ (Lambda Node 20 is fine).");
  }
}

assertFetchAvailable();

const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_RETRIES = 2;

// Only retry *safe* methods. Never retry writes here.
const RETRYABLE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function jitter(ms: number): number {
  // 0–100ms jitter to avoid thundering herd
  return ms + Math.floor(Math.random() * 100);
}

type BasicHeadersObject = {
  forEach: (callback: (value: string, key: string) => void) => void;
};

type HeadersInit = Array<[string, string]> | BasicHeadersObject | Record<string, string | string[] | undefined>;

function toHeaderRecord(
  headers: HeadersInit | undefined
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;

  // Array form: string[][] | [string, string][]
  if (Array.isArray(headers)) {
    for (const [k, v] of headers) {
      if (typeof v === "string") {
        out[k] = v;
      }
    }
    return out;
  }

  // Headers-like object (browser / undici)
  if (typeof (headers as BasicHeadersObject).forEach === "function") {
    (headers as BasicHeadersObject).forEach((v, k) => {
      out[k] = v;
    });
    return out;
  }

  // Plain object (HeaderRecord)
  for (const [k, v] of Object.entries(
    headers as Record<string, string | string[] | undefined>
  )) {
    if (typeof v === "string") {
      out[k] = v;
    } else if (Array.isArray(v)) {
      out[k] = v.join(", ");
    }
  }

  return out;
}

/**
 * Fetch wrapper:
 * - Enforces a hard timeout
 * - Adds default headers
 * - Retries transient failures for SAFE METHODS ONLY
 */
function makeFetch(baseHeaders: Record<string, string>, timeoutMs = DEFAULT_TIMEOUT_MS): typeof fetch {
  return async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const method = (init?.method ?? "GET").toUpperCase();

    const requestHeaders = toHeaderRecord(init?.headers);
    const mergedHeaders: Record<string, string> = { ...baseHeaders, ...requestHeaders };

    let attempt = 0;

    while (true) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const res = await fetch(input, {
          ...init,
          method,
          headers: mergedHeaders,
          signal: controller.signal,
        });

        // Retry only if method is safe and status is transient
        if (
          RETRYABLE_METHODS.has(method) &&
          RETRYABLE_STATUS.has(res.status) &&
          attempt < MAX_RETRIES
        ) {
          attempt += 1;
          await sleep(jitter(200 * Math.pow(2, attempt)));
          continue;
        }

        return res;
      } catch (err: unknown) {
        const message =
          err instanceof Error ? err.message : String(err);

        // Retry only safe methods on network-ish failures / aborts
        if (RETRYABLE_METHODS.has(method) && attempt < MAX_RETRIES) {
          attempt += 1;
          await sleep(jitter(200 * Math.pow(2, attempt)));
          continue;
        }

        throw new Error(`supabase_fetch_failed: ${message}`);
      } finally {
        clearTimeout(timer);
      }
    }
  };
}

const BASE_HEADERS: Record<string, string> = {
  "X-Client-Info": "alveriano-platform-api",
  "X-App-Env": config.appEnv,
};

/**
 * Factory for request-scoped clients (optional).
 * Useful when you want to attach requestId/traceId.
 */
export function createSupabaseAdminClient(extraHeaders?: Record<string, string>): SupabaseClient<Database> {
  const headers = extraHeaders ? { ...BASE_HEADERS, ...extraHeaders } : BASE_HEADERS;

  return createClient<Database>(config.supabaseUrl, config.supabaseServiceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: {
      fetch: makeFetch(headers),
      headers,
    },
    db: {
      schema: "public",
    },
  });
}

/**
 * Default singleton client (good for Lambda container reuse).
 */
export const supabaseAdmin: SupabaseClient<Database> = createSupabaseAdminClient();

// Backwards compatible export
export const supabase = supabaseAdmin;

/**
 * Optional helper: create a client with correlation headers.
 * Use this when you want per-request tracing in Supabase logs.
 */
export function supabaseForRequest(requestId?: string, traceId?: string): SupabaseClient<Database> {
  const extra: Record<string, string> = {};
  if (requestId) extra["X-Request-Id"] = requestId;
  if (traceId) extra["X-Amzn-Trace-Id"] = traceId;
  return createSupabaseAdminClient(extra);
}
