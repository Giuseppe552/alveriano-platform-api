// src/http/apiHandler.ts
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
  APIGatewayProxyStructuredResultV2,
} from "aws-lambda";
import {
  handleSubmitForm,
  type SubmitFormRequestBody,
} from "../handlers/submitForm";
import {
  handleSubmitPaidForm,
  type SubmitPaidFormRequestBody,
} from "../handlers/submitPaidForm";
import { handleStripeWebhookHttp } from "./stripeWebhook";

/**
 * Hard limits: protect Lambda + keep parsing predictable.
 * - JSON routes: small payloads only
 * - Webhook route size enforcement should live in stripeWebhook.ts (it does)
 */
const MAX_JSON_BODY_BYTES = 256 * 1024; // 256KB

/**
 * Only allow browser-originated calls from your own sites.
 * (Stripe webhooks are server-to-server, no CORS there.)
 */
const ALLOWED_ORIGINS = new Set<string>([
  "https://resinaro.com",
  "https://www.resinaro.com",
  "https://giuseppe.food",
  "https://www.giuseppe.food",
  "https://saltaireguide.uk",
  "https://www.saltaireguide.uk",
  "https://alveriano.com",
  "https://www.alveriano.com",
  "http://127.0.0.1:3000",
  "http://localhost:3000",

]);

/**
 * Use structured responses only.
 * (Prevents the annoying union-type mess + keeps logs/metrics consistent.)
 */
type ApiResult = APIGatewayProxyStructuredResultV2;

class HttpError extends Error {
  public readonly statusCode: number;
  public readonly code: string | undefined;

  constructor(statusCode: number, message: string, code?: string) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

let coldStart = true;

function nowIso() {
  return new Date().toISOString();
}

function normalizePath(rawPath?: string) {
  const p = rawPath && rawPath.trim().length > 0 ? rawPath : "/";
  if (p === "/") return "/";
  return p.endsWith("/") ? p.slice(0, -1) : p;
}

function normalizeHeaders(
  headers: Record<string, string | undefined> | undefined
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  for (const [k, v] of Object.entries(headers)) {
    if (typeof v === "string") out[k.toLowerCase()] = v;
  }
  return out;
}

function getRequestId(event: APIGatewayProxyEventV2): string {
  return (
    (event.requestContext as any)?.requestId ??
    (event.requestContext as any)?.http?.requestId ??
    "unknown"
  );
}

function getMethod(event: APIGatewayProxyEventV2) {
  return (event.requestContext?.http?.method || "UNKNOWN").toUpperCase();
}

/**
 * Security headers for API responses.
 */
function baseHeaders(requestId: string): Record<string, string> {
  return {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    "X-Request-Id": requestId,
  };
}

function jsonResponse(
  requestId: string,
  statusCode: number,
  body: unknown,
  headers?: Record<string, string>
): ApiResult {
  return {
    statusCode,
    headers: {
      ...baseHeaders(requestId),
      "Content-Type": "application/json; charset=utf-8",
      ...(headers ?? {}),
    },
    body: JSON.stringify(body),
  };
}

function emptyResponse(
  requestId: string,
  statusCode: number,
  headers?: Record<string, string>
): ApiResult {
  return {
    statusCode,
    headers: {
      ...baseHeaders(requestId),
      ...(headers ?? {}),
    },
    body: "",
  };
}

function isJsonContentType(contentType: string): boolean {
  const ct = contentType.toLowerCase();
  return ct.includes("application/json") || ct.includes("+json");
}

function getRawBodyUtf8(event: APIGatewayProxyEventV2, maxBytes: number): string {
  if (typeof event.body !== "string" || event.body.length === 0) {
    throw new HttpError(400, "Missing request body", "missing_body");
  }

  const isBase64 = event.isBase64Encoded === true;
  const buf = Buffer.from(event.body, isBase64 ? "base64" : "utf8");

  if (buf.length > maxBytes) {
    throw new HttpError(413, "Payload too large", "payload_too_large");
  }

  try {
    return buf.toString("utf8");
  } catch {
    throw new HttpError(400, "Invalid request encoding", "invalid_encoding");
  }
}

function safeJsonParse<T = unknown>(
  raw: string
): { ok: true; data: T } | { ok: false; error: string } {
  try {
    const cleaned = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    return { ok: true, data: JSON.parse(cleaned) as T };
  } catch {
    return { ok: false, error: "Invalid JSON body" };
  }
}

/**
 * CORS is only for browser-facing endpoints (/forms/*).
 */
function corsHeadersForPath(
  headers: Record<string, string>,
  path: string
): Record<string, string> | null {
  if (!path.startsWith("/forms/")) return null;

  const origin = headers["origin"];
  if (!origin) return null; // deny non-browser posting
  if (!ALLOWED_ORIGINS.has(origin)) return null;

  return {
    "Access-Control-Allow-Origin": origin,
    Vary: "Origin",
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Max-Age": "600",
  };
}

function log(
  level: "info" | "warn" | "error",
  payload: Record<string, unknown>
) {
  console[level](
    JSON.stringify({
      ts: nowIso(),
      level,
      ...payload,
    })
  );
}

type RouteContext = {
  requestId: string;
  traceId: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  cors: Record<string, string> | null;
};

type RouteHandler = (
  event: APIGatewayProxyEventV2,
  ctx: RouteContext
) => Promise<ApiResult>;

// --------------------- Error normalization ---------------------
type ErrorLike = {
  name?: unknown;
  message?: unknown;
  stack?: unknown;
  statusCode?: unknown;
  code?: unknown;
  details?: unknown;
};

function isErrorLike(v: unknown): v is ErrorLike {
  return typeof v === "object" && v !== null;
}

function sanitizeCode(code: unknown): string | undefined {
  if (typeof code !== "string") return undefined;
  const c = code.trim();
  if (c.length === 0 || c.length > 64) return undefined;
  // Keep conservative: prevents leaking raw DB errors that contain spaces, etc.
  if (!/^[a-z0-9._-]+$/i.test(c)) return undefined;
  return c;
}

function extractStatusCode(err: unknown): number | null {
  if (err instanceof HttpError) return err.statusCode;

  if (isErrorLike(err) && typeof err.statusCode === "number") {
    const sc = err.statusCode;
    if (Number.isFinite(sc) && sc >= 400 && sc <= 599) return sc;
  }
  return null;
}

function extractCode(err: unknown): string | undefined {
  if (err instanceof HttpError) return sanitizeCode(err.code);
  if (isErrorLike(err)) return sanitizeCode(err.code);
  return undefined;
}

function extractMessage(err: unknown): string | undefined {
  if (err instanceof HttpError) return err.message;
  if (err instanceof Error) return err.message;
  if (isErrorLike(err) && typeof err.message === "string") return err.message;
  return undefined;
}

function extractDetails(err: unknown): unknown {
  if (isErrorLike(err)) return err.details;
  return undefined;
}

function isAbortLike(err: unknown): boolean {
  // Defensive: node/browser mixed environments
  if (err && typeof err === "object") {
    const name = (err as any).name;
    return name === "AbortError";
  }
  return false;
}
// --------------------------------------------------------------

const routes: Record<string, RouteHandler> = {
  "POST /stripe/webhook": async (event, ctx) => {
    const res = await handleStripeWebhookHttp(event);

    if (typeof res === "string") {
      return {
        statusCode: 200,
        headers: {
          ...baseHeaders(ctx.requestId),
          "Content-Type": "text/plain; charset=utf-8",
        },
        body: res,
      };
    }

    const structured = res as ApiResult;
    return {
      ...structured,
      headers: {
        ...baseHeaders(ctx.requestId),
        ...(structured.headers ?? {}),
      },
    };
  },

  "POST /forms/submit": async (event, ctx) => {
    if (!ctx.cors) {
      throw new HttpError(403, "Origin not allowed", "cors_denied");
    }

    const contentType = ctx.headers["content-type"] ?? "";
    if (!isJsonContentType(contentType)) {
      throw new HttpError(
        415,
        "Content-Type must be application/json",
        "bad_content_type"
      );
    }

    const raw = getRawBodyUtf8(event, MAX_JSON_BODY_BYTES);
    const parsed = safeJsonParse<SubmitFormRequestBody>(raw);
    if (!parsed.ok) throw new HttpError(400, parsed.error, "invalid_json");

    const result = await handleSubmitForm(parsed.data);

    return jsonResponse(
      ctx.requestId,
      200,
      { ok: true, submissionId: result.submissionId },
      ctx.cors
    );
  },

  "POST /forms/submit-paid": async (event, ctx) => {
    if (!ctx.cors) {
      throw new HttpError(403, "Origin not allowed", "cors_denied");
    }

    const contentType = ctx.headers["content-type"] ?? "";
    if (!isJsonContentType(contentType)) {
      throw new HttpError(
        415,
        "Content-Type must be application/json",
        "bad_content_type"
      );
    }

    const raw = getRawBodyUtf8(event, MAX_JSON_BODY_BYTES);
    const parsed = safeJsonParse<SubmitPaidFormRequestBody>(raw);
    if (!parsed.ok) throw new HttpError(400, parsed.error, "invalid_json");

    const result = await handleSubmitPaidForm(parsed.data);

    return jsonResponse(
      ctx.requestId,
      200,
      {
        ok: true,
        submissionId: result.submissionId,
        clientSecret: result.clientSecret,
        amountCents: result.amountCents,
        currency: result.currency,
        description: result.description,
      },
      ctx.cors
    );
  },

  "GET /health": async (_event, ctx) => {
    return jsonResponse(ctx.requestId, 200, { ok: true, ts: nowIso() });
  },
};

/**
 * Main Lambda entrypoint
 */
export async function handler(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  const t0 = Date.now();
  const requestId = getRequestId(event);

  const path = normalizePath(event.rawPath);
  const method = getMethod(event);
  const headers = normalizeHeaders(event.headers);

  const traceId = headers["x-amzn-trace-id"] ?? "unknown";
  const sourceIp = event.requestContext.http?.sourceIp ?? "unknown";
  const userAgent = event.requestContext.http?.userAgent ?? "unknown";

  const cors = corsHeadersForPath(headers, path);

  // IMPORTANT: don’t log request bodies (PII)
  log("info", {
    msg: "api_request",
    requestId,
    traceId,
    coldStart,
    method,
    path,
    routeKey: event.routeKey ?? "unknown",
    sourceIp,
    userAgent,
    hasBody: typeof event.body === "string" && event.body.length > 0,
    isBase64Encoded: event.isBase64Encoded === true,
  });

  coldStart = false;

  try {
    // CORS preflight (only meaningful for /forms/*)
    if (method === "OPTIONS") {
      if (path.startsWith("/forms/")) {
        if (!cors) return emptyResponse(requestId, 403);
        return emptyResponse(requestId, 204, cors);
      }
      return emptyResponse(requestId, 204);
    }

    const key = `${method} ${path}`;
    const route = routes[key];

    if (!route) {
      if (path.startsWith("/forms/") && method !== "POST") {
        return jsonResponse(
          requestId,
          405,
          { ok: false, error: "Method not allowed", requestId },
          cors ?? undefined
        );
      }

      return jsonResponse(
        requestId,
        404,
        { ok: false, error: "Not found", requestId },
        cors ?? undefined
      );
    }

    const res = await route(event, {
      requestId,
      traceId,
      method,
      path,
      headers,
      cors,
    });

    log("info", {
      msg: "api_response",
      requestId,
      traceId,
      method,
      path,
      statusCode: res.statusCode,
      ms: Date.now() - t0,
    });

    return res;
  } catch (err: unknown) {
    const statusFromErr = extractStatusCode(err);
    const statusCode = statusFromErr ?? 500;

    const code = extractCode(err);
    const messageFromErr = extractMessage(err);

    // Don’t leak internals on 5xx unless it’s an HttpError (which you control).
    const isHttp = err instanceof HttpError;
    const publicMessage =
      statusCode >= 500 && !isHttp
        ? "Internal server error"
        : messageFromErr || "Request failed";

    // Only return structured details for 4xx (never on 5xx).
    const details =
      statusCode >= 400 && statusCode < 500 ? extractDetails(err) : undefined;

    const level: "warn" | "error" =
      statusCode >= 500 && !isHttp ? "error" : "warn";

    log(level, {
      msg: "api_error",
      requestId,
      traceId,
      method,
      path,
      statusCode,
      code,
      error:
        publicMessage +
        (isAbortLike(err) ? " (abort)" : ""),
      errName:
        err instanceof Error ? err.name : isErrorLike(err) ? String(err.name ?? "unknown") : "unknown",
      // stack only for 5xx (keeps logs cleaner; still no PII)
      stack:
        statusCode >= 500 && err instanceof Error ? err.stack : undefined,
      ms: Date.now() - t0,
    });

    return jsonResponse(
      requestId,
      statusCode,
      {
        ok: false,
        error: publicMessage,
        ...(code ? { code } : {}),
        ...(details ? { details } : {}),
        requestId,
      },
      cors ?? undefined
    );
  }
}
