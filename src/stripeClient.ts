import Stripe from "stripe";
import { config } from "./env";

/**
 * Stripe client is created once per Lambda container (good).
 * We pin apiVersion and add timeouts + telemetry.
 */

function assertStripeKey(key: string) {
  // Basic guard — prevents deploying with empty/wrong key
  if (!key || typeof key !== "string") {
    throw new Error("Missing STRIPE_SECRET_KEY");
  }
  const k = key.trim();
  if (!k.startsWith("sk_")) {
    throw new Error("STRIPE_SECRET_KEY does not look like a Stripe secret key");
  }
}

assertStripeKey(config.stripeSecretKey);

export const stripe = new Stripe(config.stripeSecretKey, {
  // Pin to a known stable Stripe API version.
  // Update intentionally and test webhooks/payments when you bump this.
  apiVersion: "2025-11-17.clover",

  // Prevent slow hangs consuming Lambda time budget
  timeout: 8_000, // ms

  // Basic service identification in Stripe dashboard/logs
  appInfo: {
    name: "alveriano-platform-api",
    version: "1.0.0",
  },

  // Typescript safety; helps if Stripe adds new fields
  typescript: true,
});
