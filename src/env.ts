import dotenv from "dotenv";

type AppEnv = "local" | "dev" | "staging" | "prod";

function parseAppEnv(v: string | undefined): AppEnv {
  const val = (v ?? "").trim().toLowerCase();
  if (val === "local" || val === "dev" || val === "staging" || val === "prod") return val;
  // Default safely to local for developer machines, but never “assume prod”.
  return "local";
}

export const APP_ENV: AppEnv = parseAppEnv(process.env["APP_ENV"]);
export const IS_LOCAL = APP_ENV === "local";

// Only load .env locally. In Lambda, real env vars should already exist.
if (IS_LOCAL) dotenv.config();

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") throw new Error(`Missing required environment variable: ${name}`);
  return value.trim();
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() !== "" ? value.trim() : undefined;
}

function requireUrl(name: string): string {
  const value = requireEnv(name);
  try {
    new URL(value);
  } catch {
    throw new Error(`Invalid URL in environment variable: ${name}`);
  }
  return value;
}

function requirePrefix(name: string, prefix: string): string {
  const value = requireEnv(name);
  if (!value.startsWith(prefix)) {
    throw new Error(`Invalid ${name}: expected value starting with "${prefix}"`);
  }
  return value;
}

function requireLooksLikeJwt(name: string): string {
  const value = requireEnv(name);
  // JWTs look like: header.payload.signature (base64url-ish)
  const parts = value.split(".");
  if (parts.length < 3) {
    throw new Error(`Invalid ${name}: expected JWT-like value`);
  }
  return value;
}

function requireIf(condition: boolean, name: string): string | undefined {
  if (!condition) return optionalEnv(name);
  return requireEnv(name);
}

/**
 * Central config object (easier to test/move around)
 */
export const config = {
  appEnv: APP_ENV,
  isLocal: IS_LOCAL,

  // Supabase
  supabaseUrl: requireUrl("SUPABASE_URL"),
  supabaseServiceRoleKey: requireLooksLikeJwt("SUPABASE_SERVICE_ROLE_KEY"),

  // Stripe
  stripeSecretKey: requirePrefix("STRIPE_SECRET_KEY", "sk_"),

  // Webhooks
  stripeWebhookSecret: requireIf(!IS_LOCAL, "STRIPE_WEBHOOK_SECRET"),
} as const;

// Convenience exports
export const SUPABASE_URL = config.supabaseUrl;
export const SUPABASE_SERVICE_ROLE_KEY = config.supabaseServiceRoleKey;
export const STRIPE_SECRET_KEY = config.stripeSecretKey;
export const STRIPE_WEBHOOK_SECRET = config.stripeWebhookSecret
  ? requirePrefix("STRIPE_WEBHOOK_SECRET", "whsec_")
  : undefined;
