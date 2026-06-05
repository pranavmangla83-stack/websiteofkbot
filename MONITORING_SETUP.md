# Monitoring Setup

This project uses Microsoft Clarity for visitor session recordings and Sentry for frontend and backend error monitoring.

## Microsoft Clarity

1. Go to the Microsoft Clarity dashboard and create a project for `customaichatbot.online`.
2. Copy the Clarity Project ID from the Clarity setup screen.
3. Set `CLARITY_PROJECT_ID=<project id>` in the production environment.
4. Restart the production process after updating environment variables.
5. Deploy the site and browse a few public pages on desktop and mobile.
6. In Clarity, check that recordings appear for `customaichatbot.online`. New projects can take a short time before recordings show up.

## Sentry

1. Create a Sentry organization or open the existing one.
2. Create a JavaScript browser project for the static frontend.
3. Copy the frontend DSN.
4. Set `SENTRY_FRONTEND_DSN=<frontend dsn>` in the production environment.
5. The frontend reads this public DSN from `/api/monitoring-config`.
6. Create a Node.js project for the Express backend.
7. Copy the backend DSN.
8. Add `SENTRY_BACKEND_DSN=<backend dsn>` to the production environment. This has already been added to the local `.env`.
9. Restart the PM2 process after updating environment variables. Use `npm start` or preload Sentry manually with `node --import ./backend/src/monitoring/sentry.js server.js`.

## Environment Variables

Add these values to production as needed:

```env
SENTRY_BACKEND_DSN=
SENTRY_FRONTEND_DSN=
CLARITY_PROJECT_ID=
```

The backend reads `SENTRY_BACKEND_DSN` directly from the environment. Static pages load `assets/js/monitoring.js`, which fetches `/api/monitoring-config` so the browser Sentry DSN and Clarity Project ID can also come from environment variables.

## Test Frontend Sentry

1. Deploy with `SENTRY_FRONTEND_DSN` set in the environment.
2. Open any page in a browser.
3. In DevTools Console, run:

```js
setTimeout(() => { throw new Error("Frontend Sentry test error"); }, 0);
```

4. Check the Sentry frontend project Issues page for the test error.

## Test Backend Sentry

1. Set `SENTRY_BACKEND_DSN` to the backend DSN.
2. Temporarily add a local-only route that throws an error, or trigger a controlled backend exception in development.
3. Check the Sentry backend project Issues page for the test error.
4. Remove the temporary route immediately after verification.

## Verify Error Reporting

Confirm the following after deployment:

- Browser runtime errors appear in the Sentry frontend project.
- Unhandled browser promise rejections appear in the Sentry frontend project.
- Express route exceptions appear in the Sentry backend project.
- Existing backend JSON error responses are still returned to API clients.
- Existing console logging still appears in server logs.

## Verify Clarity

Confirm the following after deployment:

- Clarity shows traffic for `customaichatbot.online`.
- Recordings appear for desktop page views.
- Recordings appear for mobile page views.
- GA4 and GTM still receive traffic independently.
