(() => {
  const placeholderValues = new Set([
    ""
  ]);

  afterFirstPaint(() => {
    loadMonitoringConfig()
      .then(({ sentryFrontendDsn, clarityProjectId, environment }) => {
        initSentry(sentryFrontendDsn, environment);
        initClarity(clarityProjectId);
      })
      .catch(() => {
        initSentry("", "production");
        initClarity("");
      });
  });

  function initLoadedSentry(sentryFrontendDsn, environment) {
    window.Sentry?.init({
      dsn: sentryFrontendDsn,
      environment: environment || "production",
      beforeSend(event) {
        event.tags = {
          ...(event.tags || {}),
          app: "customaichatbot-frontend"
        };
        return event;
      }
    });
  }

  function initSentry(sentryFrontendDsn, environment) {
    if (placeholderValues.has(sentryFrontendDsn)) return;

    if (window.Sentry) {
      initLoadedSentry(sentryFrontendDsn, environment);
      return;
    }

    const script = document.createElement("script");
    script.src = "https://browser.sentry-cdn.com/10.42.0/bundle.min.js";
    script.crossOrigin = "anonymous";
    script.integrity = "sha384-L/HYBH2QCeLyXhcZ0hPTxWMnyMJburPJyVoBmRk4OoilqrOWq5kU4PNTLFYrCYPr";
    script.onload = () => initLoadedSentry(sentryFrontendDsn, environment);
    document.head.appendChild(script);
  }

  function initClarity(clarityProjectId) {
    // Microsoft Clarity is initialized here with the official Clarity tracking script.
    if (placeholderValues.has(clarityProjectId)) return;

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

  async function loadMonitoringConfig() {
    const response = await fetch("/api/monitoring-config", {
      credentials: "same-origin",
      headers: { Accept: "application/json" }
    });

    if (!response.ok) {
      throw new Error("Monitoring config unavailable");
    }

    return response.json();
  }

  function afterFirstPaint(callback) {
    const run = () => {
      if ("requestIdleCallback" in window) {
        window.requestIdleCallback(callback, { timeout: 3000 });
      } else {
        window.setTimeout(callback, 1500);
      }
    };

    if (document.readyState === "complete") run();
    else window.addEventListener("load", run, { once: true });
  }
})();
