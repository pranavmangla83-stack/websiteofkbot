# Deployment Checklist

Use this before every production launch or payment-flow change.

## Environment

- `.env` exists only on the server and is not committed.
- `FRONTEND_URL` and `BACKEND_URL` are production HTTPS URLs.
- `KINDE_AUDIENCE` matches `assets/js/kinde-config.js`.
- Razorpay live keys, live plan IDs, and live webhook secret are used together.
- Supabase service/secret key is backend-only.
- `ADMIN_EMAILS` contains only real admin accounts.

## Infrastructure

- HTTPS is active for frontend, backend, widget, and webhook routes.
- Reverse proxy upload limit is at least 10MB and not much higher.
- Process manager restarts Node after crash or deploy.
- `GET /api/health` is monitored.
- 4xx/5xx logs, payment webhook logs, PDF processing failures, and OpenAI failures are retained.

## Database

- `npm run db:migrate` completed successfully.
- `plans` contains Basic INR 350/month and Pro INR 500/month.
- RLS is enabled on tenant tables.
- `client-pdfs` bucket is private and limited to PDF MIME type.
- Vector index exists on `document_chunks.embedding`.

## Launch Tests

- New signup reaches dashboard after Kinde redirect.
- `POST /api/auth/sync-user` creates client, user, and default chatbot.
- `GET /api/me` returns only the logged-in tenant.
- Basic checkout opens with INR 350/month.
- Pro checkout opens with INR 500/month.
- Payment verification does not activate features until webhook/subscription status is active.
- Razorpay webhook rejects invalid signatures.
- Duplicate webhook delivery does not duplicate payment rows.
- PDF upload accepts a valid PDF and rejects a renamed non-PDF.
- PDF processing reaches `completed` or shows a clear `failed` reason.
- Chat only answers from the tenant's chunks.
- Public widget works on the saved website origin and fails on another origin.
- Website crawling cannot fetch localhost, private IPs, or metadata IPs.
