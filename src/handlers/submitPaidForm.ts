import { createFormSubmission, FormSubmissionInput } from "../forms";
import { stripe } from "../stripeClient";

export interface PaidFormPaymentInfo {
  amountCents: number;
  currency: string;
  description: string;
}

export interface SubmitPaidFormRequestBody extends FormSubmissionInput {
  payment: PaidFormPaymentInfo;
  idempotencyKey?: string | null;
}

export interface SubmitPaidFormResult {
  submissionId: string;
  clientSecret: string;
  amountCents: number;
  currency: string;
  description?: string;
}

/**
 * Core logic for "POST /forms/submit-paid" (paid forms using Stripe Elements).
 *
 * Flow:
 * 1) Create a form_submissions row in Supabase.
 * 2) Create a Stripe PaymentIntent with metadata linking back to that submission.
 * 3) Return { submissionId, clientSecret } for the frontend to use with Stripe.js.
 */
export async function handleSubmitPaidForm(
  body: SubmitPaidFormRequestBody
): Promise<SubmitPaidFormResult> {
  const { site, formSlug, email, name, phone, sourceUrl, payload, payment, idempotencyKey } = body;

  if (!site || !formSlug) {
    throw new Error("Missing required fields: site and formSlug");
  }

  if (!payment || !payment.amountCents || !payment.currency) {
    throw new Error("Missing payment information");
  }

  // 1) Create the form submission in Supabase
  const submission = await createFormSubmission({
    site,
    formSlug,
    email: email ?? null,
    name: name ?? null,
    phone: phone ?? null,
    sourceUrl: sourceUrl ?? null,
    payload: payload ?? null,
    status: "pending_payment",
    submissionKey: idempotencyKey ?? null,
  });

  const submissionId = submission["id"] as string;

  // 2) Create Stripe PaymentIntent
  const paymentIntent = await stripe.paymentIntents.create({
    amount: payment.amountCents,
    currency: payment.currency,
    description: payment.description,
    metadata: {
      form_submission_id: submissionId,
      site,
      form_slug: formSlug
    },
    automatic_payment_methods: {
      enabled: true
    }
  });

  if (!paymentIntent.client_secret) {
    throw new Error("Stripe did not return a client_secret");
  }

  // 3) Return ids for frontend
  return {
    submissionId,
    clientSecret: paymentIntent.client_secret,
    amountCents: paymentIntent.amount,
    currency: paymentIntent.currency,
    description: paymentIntent.description ?? payment.description,
  };
}
