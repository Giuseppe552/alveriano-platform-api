import dotenv from "dotenv";
import { z } from "zod";

const IS_LAMBDA = Boolean(
  process.env.AWS_LAMBDA_FUNCTION_NAME ||
    (process.env.AWS_EXECUTION_ENV ?? "").includes("AWS_Lambda")
);

const AppEnvSchema = z.enum(["local", "dev", "staging", "prod"]);
export type AppEnv = z.infer<typeof AppEnvSchema>;

function resolveAppEnv(): AppEnv {
  const raw = (process.env.APP_ENV ?? "").trim().toLowerCase();

  // Never silently default inside AWS. Misconfig should crash loudly.
  if (!raw) {
    if (IS_LAMBDA) {
      throw new Error(
        "APP_ENV is required in Lambda (dev|staging|prod). Refusing to default."
      );
    }
    return "local";
  }

  const parsed = AppEnvSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Invalid APP_ENV: "${raw}". Expected one of: ${AppEnvSchema.options.join(
        ", "
      )}`
    );
  }
  return parsed.data;
}

export const APP_ENV: AppEnv = resolveAppEnv();
export const IS_LOCAL = APP_ENV === "local" && !IS_LAMBDA;

// Only load .env locally. Never in Lambda.
if (IS_LOCAL) {
  dotenv.config({ override: false });
}

const NonEmpty = z.string().trim().min(1);

const HttpsUrl = NonEmpty.superRefine((val, ctx) => {
  try {
    const u = new URL(val);
    if (u.protocol !== "https:") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "URL must use https",
      });
    }
  } catch {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Invalid URL",
    });
  }
});

const JwtLike = NonEmpty.superRefine((val, ctx) => {
  // JWT-ish: header.payload.signature (base64url-ish)
  const parts = val.split(".");
  if (parts.length < 3) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Expected JWT-like value (header.payload.signature)",
    });
  }
});

const StripeSecretKey = NonEmpty.superRefine((val, ctx) => {
  // Accept sk_test_ / sk_live_ (and any future suffix)
  if (!val.startsWith("sk_")) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Expected value starting with "sk_"',
    });
  }
});

const StripeWebhookSecret = NonEmpty.superRefine((val, ctx) => {
  if (!val.startsWith("whsec_")) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Expected value starting with "whsec_"',
    });
  }
});

function readEnv(): Record<string, string | undefined> {
  // keep it explicit: avoids accidentally validating random env noise
  return {
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
    STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET,
    LOG_LEVEL: process.env.LOG_LEVEL,
    AWS_REGION: process.env.AWS_REGION,
  };
}

const EnvSchema = z.object({
  SUPABASE_URL: HttpsUrl,
  SUPABASE_SERVICE_ROLE_KEY: JwtLike,
  STRIPE_SECRET_KEY: StripeSecretKey,
  STRIPE_WEBHOOK_SECRET: z.string().trim().optional(),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).optional(),
  AWS_REGION: z.string().trim().optional(),
});

const parsed = EnvSchema.safeParse(readEnv());
if (!parsed.success) {
  // zod does NOT include raw values in this message, so no secret leakage.
  const issues = parsed.error.issues
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
  throw new Error(`Invalid environment configuration: ${issues}`);
}

const stripeWebhookSecret = parsed.data.STRIPE_WEBHOOK_SECRET
  ? StripeWebhookSecret.parse(parsed.data.STRIPE_WEBHOOK_SECRET)
  : undefined;

// If you expose /stripe/webhook, this must be present outside local.
if (!IS_LOCAL && !stripeWebhookSecret) {
  throw new Error(
    "Missing STRIPE_WEBHOOK_SECRET outside local. Refusing to run webhook endpoint unsigned."
  );
}

/**
 * Central config (single source of truth).
 * Do NOT log this object (it contains secrets).
 */
export const config = Object.freeze({
  appEnv: APP_ENV,
  isLocal: IS_LOCAL,

  supabaseUrl: parsed.data.SUPABASE_URL,
  supabaseServiceRoleKey: parsed.data.SUPABASE_SERVICE_ROLE_KEY,

  stripeSecretKey: parsed.data.STRIPE_SECRET_KEY,
  stripeWebhookSecret,

  logLevel: parsed.data.LOG_LEVEL ?? "info",
  awsRegion: parsed.data.AWS_REGION,
} as const);

// Backwards-compatible named exports
export const SUPABASE_URL = config.supabaseUrl;
export const SUPABASE_SERVICE_ROLE_KEY = config.supabaseServiceRoleKey;
export const STRIPE_SECRET_KEY = config.stripeSecretKey;
export const STRIPE_WEBHOOK_SECRET = config.stripeWebhookSecret;
