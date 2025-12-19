import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from "aws-lambda";
import Stripe from "stripe";
import { stripe } from "../stripeClient";
import { STRIPE_WEBHOOK_SECRET } from "../env";
import { handleStripeEvent } from "../handlers/stripeEvent";

/**
 * Stripe webhooks are security-sensitive:
 * - Signature verification must use the exact raw bytes of the request body
 * - Handler must be idempotent (Stripe retries on 5xx)
 */

const MAX_BODY_BYTES = 1 * 1024 * 1024; // 1MB
const SIGNATURE_TOLERANCE_SECONDS = 5 * 60; // 5 minutes (tight replay window)

type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };

function jsonResponse(
  statusCode: number,
  body: Json,
  extraHeaders?: Record<string, string>
): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  };
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

function safeErr(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === "string" ? err : "unknown_error";
}

function log(
  level: "info" | "warn" | "error",
  payload: Record<string, unknown>
) {
  // Structured logs play nicely with CloudWatch and any future log pipeline
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    ...payload,
  });
  // eslint-disable-next-line no-console
  console[level](line);
}

function parseRawBody(event: APIGatewayProxyEventV2): Buffer | null {
  if (!event.body) return null;

  const isBase64 = event.isBase64Encoded === true;

  // IMPORTANT: keep bytes exact for signature verification
  const buf = Buffer.from(event.body, isBase64 ? "base64" : "utf8");
  return buf;
}

export async function handleStripeWebhookHttp(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  const t0 = Date.now();

  const headers = normalizeHeaders(event.headers);

  const requestId = event.requestContext.requestId ?? "unknown";
  const method = event.requestContext.http?.method?.toUpperCase() ?? "UNKNOWN";
  const path = event.requestContext.http?.path ?? "unknown";
  const sourceIp = event.requestContext.http?.sourceIp ?? "unknown";
  const userAgent = event.requestContext.http?.userAgent ?? "unknown";
  const traceId = headers["x-amzn-trace-id"] ?? "unknown";

  // Method guard
  if (method !== "POST") {
    return jsonResponse(405, { error: "Method not allowed" }, { Allow: "POST" });
  }

  // Ensure configured
  if (!STRIPE_WEBHOOK_SECRET) {
    log("error", {
      msg: "stripe_webhook_missing_secret",
      requestId,
      traceId,
      path,
    });
    return jsonResponse(500, { error: "Webhook not configured" });
  }

  // Require signature header (case-insensitive after normalize)
  const signature = headers["stripe-signature"];
  if (!signature) {
    log("warn", {
      msg: "stripe_webhook_missing_signature",
      requestId,
      traceId,
      path,
      sourceIp,
    });
    return jsonResponse(400, { error: "Missing Stripe-Signature header" });
  }

  // Read raw body bytes and enforce max size
  const rawBody = parseRawBody(event);
  if (!rawBody) {
    return jsonResponse(400, { error: "Missing request body" });
  }
  if (rawBody.length > MAX_BODY_BYTES) {
    log("warn", {
      msg: "stripe_webhook_body_too_large",
      requestId,
      traceId,
      bytes: rawBody.length,
      path,
      sourceIp,
    });
    return jsonResponse(413, { error: "Payload too large" });
  }

  // (Optional strictness) Stripe sends JSON; don’t block if you’re unsure
  // const contentType = headers["content-type"] ?? "";
  // if (!contentType.includes("application/json")) {
  //   return jsonResponse(415, { error: "Unsupported media type" });
  // }

  let stripeEvent: Stripe.Event;
  try {
    // Using Buffer preserves exact bytes.
    // Tolerance reduces replay window risk.
    stripeEvent = stripe.webhooks.constructEvent(
      rawBody,
      signature,
      STRIPE_WEBHOOK_SECRET,
      SIGNATURE_TOLERANCE_SECONDS
    );
  } catch (err) {
    log("warn", {
      msg: "stripe_webhook_invalid_signature",
      requestId,
      traceId,
      path,
      sourceIp,
      userAgent,
      err: safeErr(err),
    });
    // Do NOT echo error details back to caller
    return jsonResponse(400, { error: "Invalid signature" });
  }

  log("info", {
    msg: "stripe_webhook_received",
    requestId,
    traceId,
    path,
    stripeEventId: stripeEvent.id,
    type: stripeEvent.type,
    livemode: stripeEvent.livemode,
    apiVersion: stripeEvent.api_version ?? "unknown",
    ms: Date.now() - t0,
  });

  try {
    /**
     * IMPORTANT:
     * handleStripeEvent MUST be idempotent using stripeEvent.id:
     * - write stripeEvent.id to DB as processed
     * - skip if already processed
     * This enables safe retries (Stripe retries on 5xx).
     */
    const result = await handleStripeEvent(stripeEvent);

    log("info", {
      msg: "stripe_webhook_handled",
      requestId,
      traceId,
      stripeEventId: stripeEvent.id,
      type: stripeEvent.type,
      handled: result.handled,
      ms: Date.now() - t0,
    });

    return jsonResponse(200, { ok: true, handled: result.handled });
  } catch (err) {
    log("error", {
      msg: "stripe_webhook_handler_failed",
      requestId,
      traceId,
      stripeEventId: stripeEvent.id,
      type: stripeEvent.type,
      err: safeErr(err),
      ms: Date.now() - t0,
    });

    // Correct behavior: return 500 so Stripe retries.
    // Only safe if handler is idempotent.
    return jsonResponse(500, { ok: false });
  }
}
