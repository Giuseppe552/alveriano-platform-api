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

const MAX_JSON_BODY_BYTES = 256 * 1024; // 256KB

// Only allow browser calls from your own sites
const ALLOWED_ORIGINS = new Set<string>([
  "https://resinaro.com",
  "https://www.resinaro.com",
  "https://giuseppe.food",
  "https://www.giuseppe.food",
  "https://saltaireguide.uk",
  "https://www.saltaireguide.uk",
  "https://alveriano.com",
  "https://www.alveriano.com",
]);

class HttpError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
    this.name = "HttpError";
  }
}

type ApiResult = APIGatewayProxyStructuredResultV2;

/**
 * Normalize paths so `/forms/submit-paid/` works the same as `/forms/submit-paid`
 */
function normalizePath(rawPath?: string) {
  const p = rawPath || "/";
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

function jsonResponse(
  statusCode: number,
  body: unknown,
  headers?: Record<string, string>
): ApiResult {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...(headers ?? {}),
    },
    body: JSON.stringify(body),
  };
}

function emptyResponse(statusCode: number, headers?: Record<string, string>): ApiResult {
  return {
    statusCode,
    headers: {
      "Cache-Control": "no-store",
      ...(headers ?? {}),
    },
    body: "",
  };
}

function getCorsHeadersForRequest(
  headers: Record<string, string>,
  path: string
): Record<string, string> | null {
  // Only enable CORS for browser-facing form endpoints
  if (!path.startsWith("/forms/")) return null;

  const origin = headers["origin"];
  if (!origin) return null;

  if (!ALLOWED_ORIGINS.has(origin)) {
    // Do not reflect arbitrary origins
    return null;
  }

  return {
    "Access-Control-Allow-Origin": origin,
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
  };
}

function getMethod(event: APIGatewayProxyEventV2) {
  return (event.requestContext?.http?.method || "UNKNOWN").toUpperCase();
}

function getRawBodyAsUtf8(event: APIGatewayProxyEventV2): string | null {
  if (typeof event.body !== "string" || event.body.length === 0) return null;

  const buf = Buffer.from(event.body, event.isBase64Encoded ? "base64" : "utf8");
  if (buf.length > MAX_JSON_BODY_BYTES) {
    throw new HttpError(413, "Payload too large");
  }
  return buf.toString("utf8");
}

function safeJsonParse<T = unknown>(
  raw: string
): { ok: true; data: T } | { ok: false; error: string } {
  try {
    return { ok: true, data: JSON.parse(raw) as T };
  } catch {
    return { ok: false, error: "Invalid JSON body" };
  }
}

function log(level: "info" | "warn" | "error", payload: Record<string, unknown>) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    ...payload,
  });
  // eslint-disable-next-line no-console
  console[level](line);
}

type RouteHandler = (
  event: APIGatewayProxyEventV2,
  ctx: {
    requestId: string;
    method: string;
    path: string;
    headers: Record<string, string>;
    cors: Record<string, string> | null;
    traceId: string;
  }
) => Promise<ApiResult>;

const routes: Record<string, RouteHandler> = {
  "POST /stripe/webhook": async (event) => {
    // Stripe endpoint: no CORS needed.
    // handleStripeWebhookHttp is typed as APIGatewayProxyResultV2 (union),
    // but we only return structured responses in our implementation.
    const res = await handleStripeWebhookHttp(event);

    // Be robust: if a string ever slips through, wrap it.
    if (typeof res === "string") {
      return {
        statusCode: 200,
        headers: {
          "Content-Type": "text/plain",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
        body: res,
      };
    }

    return res as ApiResult;
  },

  "POST /forms/submit": async (event, ctx) => {
    const contentType = ctx.headers["content-type"] ?? "";
    if (!contentType.toLowerCase().includes("application/json")) {
      throw new HttpError(415, "Content-Type must be application/json");
    }

    const raw = getRawBodyAsUtf8(event);
    if (!raw) throw new HttpError(400, "Missing request body");

    const parsed = safeJsonParse(raw);
    if (!parsed.ok) throw new HttpError(400, parsed.error);

    // NOTE: Still a TS cast. Next step: Zod validation.
    const result = await handleSubmitForm(parsed.data as SubmitFormRequestBody);

    return jsonResponse(200, { ok: true, submissionId: result.submissionId }, ctx.cors ?? undefined);
  },

  "POST /forms/submit-paid": async (event, ctx) => {
    const contentType = ctx.headers["content-type"] ?? "";
    if (!contentType.toLowerCase().includes("application/json")) {
      throw new HttpError(415, "Content-Type must be application/json");
    }

    const raw = getRawBodyAsUtf8(event);
    if (!raw) throw new HttpError(400, "Missing request body");

    const parsed = safeJsonParse<SubmitPaidFormRequestBody>(raw);
    if (!parsed.ok) throw new HttpError(400, parsed.error);

    const result = await handleSubmitPaidForm(parsed.data);

    return jsonResponse(
      200,
      {
        ok: true,
        submissionId: result.submissionId,
        clientSecret: result.clientSecret,
        amountCents: result.amountCents,
        currency: result.currency,
        description: result.description,
      },
      ctx.cors ?? undefined
    );
  },
};

/**
 * Main Lambda entrypoint
 */
export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const t0 = Date.now();

  const path = normalizePath(event.rawPath);
  const method = getMethod(event);
  const headers = normalizeHeaders(event.headers);

  const requestId = event.requestContext.requestId ?? "unknown";
  const traceId = headers["x-amzn-trace-id"] ?? "unknown";
  const sourceIp = event.requestContext.http?.sourceIp ?? "unknown";
  const userAgent = event.requestContext.http?.userAgent ?? "unknown";

  const cors = getCorsHeadersForRequest(headers, path);

  log("info", {
    msg: "api_request",
    requestId,
    traceId,
    method,
    path,
    sourceIp,
    userAgent,
    hasBody: !!event.body,
    isBase64Encoded: !!event.isBase64Encoded,
  });

  try {
    // CORS preflight only relevant for /forms/*
    if (method === "OPTIONS") {
      if (cors) return emptyResponse(204, cors);
      return emptyResponse(204);
    }

    const key = `${method} ${path}`;
    const route = routes[key];

    if (!route) {
      if (path.startsWith("/forms/") && method !== "POST") {
        return jsonResponse(405, { error: "Method not allowed" }, cors ?? undefined);
      }
      return jsonResponse(404, { error: "Not found" }, cors ?? undefined);
    }

    const res = await route(event, { requestId, method, path, headers, cors, traceId });

    log("info", {
      msg: "api_response",
      requestId,
      traceId,
      method,
      path,
      statusCode: res.statusCode, // ✅ now always exists (structured type)
      ms: Date.now() - t0,
    });

    return res;
  } catch (err: any) {
    const isHttp = err instanceof HttpError;

    log(isHttp ? "warn" : "error", {
      msg: "api_error",
      requestId,
      traceId,
      method,
      path,
      statusCode: isHttp ? err.statusCode : 500,
      error: err?.message ?? String(err),
      stack: err?.stack,
      ms: Date.now() - t0,
    });

    return jsonResponse(
      isHttp ? err.statusCode : 500,
      { error: isHttp ? err.message : "Internal server error" },
      cors ?? undefined
    );
  }
}
