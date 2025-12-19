# Alveriano Platform API

Backend for the **Alveriano platform** – a small, multi-tenant API that powers
forms and payments for several brands (e.g. Resinaro, Saltaire Guide, Roofersbook).

The goal is:

- one **secure, central API**
- many **websites / brands on top**
- consistent **storage, audit logs and webhooks** underneath.

---

## Features

- **Multi-tenant forms**
  - Single `POST /forms/submit` endpoint
  - Each submission tagged with `site` (e.g. `resinaro`, `saltaire_guide`) and `formSlug`
  - JSON payload stored in Postgres as `jsonb` for flexibility

- **Payment event ingestion**
  - Stripe Webhook endpoint (e.g. `POST /webhooks/stripe`)
  - Persists payment events in a separate `payments` table for CRM / dashboards

- **Simple CRM-friendly schema**
  - `form_submissions` table – one row per submitted form
  - `payments` table – one row per payment or significant Stripe event
  - Designed so a founder or ops person can query everything from Supabase UI

- **Multi-brand ready**
  - Frontend sites send `site` + `formSlug`
  - Backend doesn’t know or care about specific pages – only contracts and validation

- **Security-first configuration**
  - No secrets in the repo – all keys and tokens must come from environment variables
  - Ready for deployment on Vercel / Railway / fly.io / your favourite host

---

## Tech Stack

- **Runtime:** Node.js / TypeScript
- **Framework:** Express / Fastify-style HTTP API (thin layer, no heavy framework)
- **Database:** PostgreSQL (Supabase managed instance in production)
- **ORM / Query:** SQL or a light query builder (e.g. `postgres.js`/`knex`) – minimal abstraction
- **Auth / Secrets:** Environment variables only (never committed)

---

## Data Model (high level)

### `form_submissions`

Holds all structured + unstructured form data.

| Column         | Type      | Notes                                  |
| -------------- | --------- | -------------------------------------- |
| `id`           | uuid      | Primary key                            |
| `site`         | text      | e.g. `resinaro`, `saltaire_guide`     |
| `form_slug`    | text      | e.g. `passport_onboarding`, `lead-intake` |
| `email`        | text      | Optional convenience column            |
| `name`         | text      | Optional convenience column            |
| `phone`        | text      | Optional convenience column            |
| `payload`      | jsonb     | Raw form payload                       |
| `created_at`   | timestamptz | Insert timestamp                     |
| `source_url`   | text      | Page the form was submitted from      |

Example payload shape (values are illustrative only):

```jsonc
{
  "site": "resinaro",
  "formSlug": "service_onboarding",
  "email": "user@example.com",
  "name": "Mario Rossi",
  "phone": "+44 7000 000000",
  "sourceUrl": "https://resinaro.com/en/services/example",
  "payload": {
    "bookingId": "EXAMPLE-BOOKING-ID",
    "locale": "en",
    "notes": "Example notes from the user",
    "extra": { "anything": "your frontend needs to send" }
  }
}
````

### `payments`

Stores Stripe payment intent events and related metadata.

| Column               | Type        | Notes                                             |
| -------------------- | ----------- | ------------------------------------------------- |
| `id`                 | uuid        | Primary key                                       |
| `site`               | text        | Which site the payment belongs to                 |
| `stripe_customer_id` | text        | Optional customer id                              |
| `payment_intent_id`  | text        | Stripe PaymentIntent id                           |
| `amount_cents`       | integer     | Amount in smallest currency unit                  |
| `currency`           | text        | ISO currency code                                 |
| `status`             | text        | e.g. `succeeded`, `requires_payment_method`       |
| `raw_event`          | jsonb       | Full Stripe event payload (redacted where needed) |
| `created_at`         | timestamptz | When we first saw the event                       |
| `updated_at`         | timestamptz | Last update                                       |

---

## API Overview

### `POST /forms/submit`

Generic endpoint to record a form submission.

* Validates required fields (`site`, `formSlug`, `email` at minimum)
* Stores a normalised row in `form_submissions`
* Stores full payload in `payload` column for later parsing / reporting
* Designed to be called directly from Next.js frontends

Request body (example):

```jsonc
{
  "site": "resinaro",
  "formSlug": "service_onboarding",
  "email": "user@example.com",
  "name": "Mario Rossi",
  "phone": "+44 7000 000000",
  "sourceUrl": "https://resinaro.com/en/services/passport/onboarding",
  "payload": {
    "bookingId": "EXAMPLE-BOOKING-ID",
    "locale": "en",
    "qty": 2,
    "people": [
      {
        "type": "self",
        "fullName": "Mario Rossi"
      }
    ]
  }
}
```

Response:

```json
{ "ok": true }
```

### `POST /webhooks/stripe`

Endpoint for Stripe webhooks.

* Verifies the event using Stripe’s webhook secret
* Upserts into `payments` based on `payment_intent.id`
* Records the raw event in `raw_event` for audit/debugging

Response:

```json
{ "received": true }
```

---

## Local Development

1. **Clone the repo**

```bash
git clone https://github.com/your-username/alveriano-platform-api.git
cd alveriano-platform-api
```

2. **Install dependencies**

```bash
pnpm install   # or npm / yarn
```

3. **Create `.env.local`**

```bash
cp .env.example .env.local
```

Fill in the values:

```bash
# Database
DATABASE_URL=postgres://user:password@host:5432/dbname

# Stripe (test keys for local dev)
STRIPE_SECRET_KEY=sk_test_xxx
STRIPE_WEBHOOK_SECRET=whsec_xxx

# Misc
NODE_ENV=development
PORT=4000
```

> **Important:** `.env.local` is git-ignored and should never be committed.

4. **Run migrations / create tables**

Use your preferred migration tool or run the SQL in `./db/schema.sql`:

```bash
pnpm db:migrate
```

5. **Start the dev server**

```bash
pnpm dev
```

---

## Security & Privacy

* No production keys, secrets, or customer data live in this repo.
* All sensitive values are loaded from environment variables.
* The only data persisted by this service is:

  * form submissions from websites that use this API, and
  * Stripe events relating to those sites.
* When using this project as a portfolio piece:

  * Use **fake data** in code snippets and tests.
  * Rotate any keys that were ever accidentally committed in the past.

---

## Example Frontend Integration

From a Next.js app, you can POST directly to the API:

```ts
await fetch(`${process.env.NEXT_PUBLIC_FORMS_API_BASE}/forms/submit`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    site: "resinaro",
    formSlug: "service_onboarding",
    email,
    name,
    phone,
    sourceUrl: window.location.href,
    payload: {
      // context specific to this form
    }
  }),
});
```

This keeps frontend form logic simple while centralising all storage and auditing in one place.

---

## Roadmap

* Admin dashboard / lightweight CRM per site (filter submissions + payments)
* Basic search / tagging for submissions
* Role-based access control for different brands
* Optional email dispatch on new submission / payment

---

## License

MIT – see `LICENSE` for details.

```

