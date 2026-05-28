# Customer Onboarding Checklist

Use this for each paying customer.

## Before Payment

- Confirm customer email and company name.
- Confirm the website where the widget will be installed.
- Explain current limits: Basic supports 3 PDFs up to 7MB; Pro supports 5 PDFs up to 10MB and website crawling.

## After Payment

- Confirm Razorpay subscription is active in the admin dashboard.
- Ask the customer to save their allowed website URL in the dashboard.
- Upload one known-good PDF first and wait for processing to complete.
- Ask three test questions whose answers are clearly in the PDF.
- Ask one question that is not in the PDF and verify the fallback answer.

## Embed

- Copy the script from the dashboard after the website URL is saved.
- Install it before the closing `</body>` tag.
- Test on desktop and mobile.
- If the widget says it is not allowed on the website, compare the browser origin with the saved website URL.

## Support Handoff

- Record customer email, client ID, plan, website URL, and subscription ID.
- Record uploaded PDF count, processing status, and first successful chat timestamp.
- Tell the customer what happens when monthly reply limits are reached.
- Keep failed PDF errors and webhook/payment events available for support.
