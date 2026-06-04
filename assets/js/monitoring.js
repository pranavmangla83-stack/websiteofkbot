(() => {
  const sentryFrontendDsn = "https://af293bcbe90c3f7535ebf43a171ec3d8@o4511508156317696.ingest.de.sentry.io/4511508230701136";
  const clarityProjectId = "x1tkzt4wzt";
  const placeholderValues = new Set([
    ""
  ]);

  // Sentry is initialized here for static HTML pages loaded on desktop and mobile.
  if (window.Sentry && !placeholderValues.has(sentryFrontendDsn)) {
    window.Sentry.init({
      dsn: sentryFrontendDsn,
      environment: "production",
      beforeSend(event) {
        event.tags = {
          ...(event.tags || {}),
          app: "customaichatbot-frontend"
        };
        return event;
      }
    });
  }

  // Microsoft Clarity is initialized here with the official Clarity tracking script.
  if (!placeholderValues.has(clarityProjectId)) {
    (function(c, l, a, r, i, t, y) {
      c[a] = c[a] || function() {
        (c[a].q = c[a].q || []).push(arguments);
      };
      t = l.createElement(r);
      t.async = 1;
      t.src = "https://www.clarity.ms/tag/" + i;
      y = l.getElementsByTagName(r)[0];
      y.parentNode.insertBefore(t, y);
    })(window, document, "clarity", "script", clarityProjectId);
  }
})();
