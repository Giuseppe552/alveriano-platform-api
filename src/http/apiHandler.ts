// src/http/apiHandler.ts
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";

type SecretJson = Record<string, unknown>;

let bootstrapPromise: Promise<void> | null = null;

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function setIfMissing(key: string, value: unknown) {
  if (isNonEmptyString(process.env[key])) return;
  if (isNonEmptyString(value)) process.env[key] = value.trim();
}

async function bootstrapRuntimeEnv(): Promise<void> {
  // Don’t run twice (cold start caching)
  if (bootstrapPromise) return bootstrapPromise;

  bootstrapPromise = (async () => {
    const isLambda = isNonEmptyString(process.env["AWS_LAMBDA_FUNCTION_NAME"]);
    if (!isLambda) return;

    const secretArn = process.env["CONFIG_SECRET_ARN"];
    const region = process.env["CONFIG_SECRET_REGION"] || process.env["AWS_REGION"];

    // If you didn’t configure Secrets Manager, we can’t help here.
    // Let existing env validation throw cleanly in env.ts.
    if (!isNonEmptyString(secretArn) || !isNonEmptyString(region)) return;

    const client = new SecretsManagerClient({ region });
    const resp = await client.send(new GetSecretValueCommand({ SecretId: secretArn }));

    if (!isNonEmptyString(resp.SecretString)) {
      throw new Error("CONFIG_SECRET_ARN returned no SecretString (expected JSON).");
    }

    let json: SecretJson;
    try {
      json = JSON.parse(resp.SecretString);
    } catch {
      throw new Error("CONFIG_SECRET_ARN SecretString is not valid JSON.");
    }

    // Map JSON -> env vars expected by src/env.ts
    setIfMissing("SUPABASE_URL", json["SUPABASE_URL"]);
    setIfMissing("SUPABASE_SERVICE_ROLE_KEY", json["SUPABASE_SERVICE_ROLE_KEY"]);
    setIfMissing("STRIPE_SECRET_KEY", json["STRIPE_SECRET_KEY"]);
    // Optional but likely needed for /stripe/webhook route
    setIfMissing("STRIPE_WEBHOOK_SECRET", json["STRIPE_WEBHOOK_SECRET"]);
  })();

  return bootstrapPromise;
}

// Lambda entrypoint. IMPORTANT: only load the real app after bootstrapRuntimeEnv().
export const handler = async (...args: any[]) => {
  await bootstrapRuntimeEnv();
  // Load the original handler AFTER env vars exist.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const core = require("./apiHandlerCore") as { handler: (...a: any[]) => any };
  return core.handler(...args);
};
