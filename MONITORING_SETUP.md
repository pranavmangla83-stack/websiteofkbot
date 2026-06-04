# Monitoring Setup

This project uses Microsoft Clarity for visitor session recordings and Sentry for frontend and backend error monitoring.

## Microsoft Clarity

1. Go to the Microsoft Clarity dashboard and create a project for `customaichatbot.online`.
2. Copy the Clarity Project ID from the Clarity setup screen.
3. Open `assets/js/monitoring.js`.
4. Confirm `clarityProjectId` is set to `x1tkzt4wzt`.
5. Deploy the site and browse a few public pages on desktop and mobile.
6. In Clarity, check that recordings appear for `customaichatbot.online`. New projects can take a short time before recordings show up.

## Sentry

1. Create a Sentry organization or open the existing one.
2. Create a JavaScript browser project for the static frontend.
3. Copy the frontend DSN.
4. Open `assets/js/monitoring.js`.
5. Confirm `sentryFrontendDsn` is set to the frontend DSN. This has already been added locally.
6. Create a Node.js project for the Express backend.
7. Copy the backend DSN.
8. Add `SENTRY_BACKEND_DSN=<backend dsn>` to the production `.env`. This has already been added to the local `.env`.
9. Restart the PM2 process after updating environment variables. Use `npm start` or preload Sentry manually with `node --import ./backend/src/monitoring/sentry.js server.js`.

## Environment Variables

Add these values to production as needed:

```env
SENTRY_BACKEND_DSN=
SENTRY_FRONTEND_DSN=
CLARITY_PROJECT_ID=
```

The backend reads `SENTRY_BACKEND_DSN` from `.env`. The frontend DSN is set in `assets/js/monitoring.js` because static HTML cannot read `.env` values at runtime without a build step or server-side injection.

## Test Frontend Sentry

1. Deploy with the real frontend DSN in `assets/js/monitoring.js`.
2. Open any page in a browser.
3. In DevTools Console, run:

```js
setTimeout(() => { throw new Error("Frontend Sentry test error"); }, 0);
```

4. Check the Sentry frontend project Issues page for the test error.

## Test Backend Sentry

1. Set `NODE_ENV=development` or another non-production value.
2. Set `SENTRY_BACKEND_DSN` to the backend DSN.
3. Start the backend.
4. Request:

```bash
curl http://localhost:4000/api/debug-sentry
```

5. Check the Sentry backend project Issues page for `Backend Sentry debug error`.
6. Set `NODE_ENV=production` again before production deployment. The route is hidden in production.

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
