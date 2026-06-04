import dotenv from "dotenv";
import * as Sentry from "@sentry/node";

dotenv.config();

const sentryBackendDsn = process.env.SENTRY_BACKEND_DSN?.trim();

if (sentryBackendDsn) {
  Sentry.init({
    dsn: sentryBackendDsn,
    environment: process.env.NODE_ENV || "development",
    tracesSampleRate: 0
  });
}

export { Sentry };
