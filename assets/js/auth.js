import createKindeClient from "../vendor/kinde-auth-pkce-js.esm.js";
import { kindeConfig } from "./kinde-config.js?v=20260530-restore";

const isLocalhost = ["localhost", "127.0.0.1"].includes(window.location.hostname);
const siteUrl = isLocalhost ? kindeConfig.localSiteUrl : kindeConfig.productionSiteUrl;
const backendUrl = (isLocalhost ? kindeConfig.localBackendUrl : kindeConfig.productionBackendUrl).replace(/\/$/, "");
const dashboardPath = "/dashboard.html";
const redirectStorageKey = "kbot_post_auth_redirect";
const authIntentStorageKey = "kbot_auth_intent";
const checkoutIntentStorageKey = "kbot_checkout_intent";

let kindeClient;
let currentAccount;
let currentBilling;
let redirectingAfterAuth = false;
let authFlowStarting = false;

initAuth();

async function initAuth() {
  if (!hasKindeConfig()) {
    console.warn("Kinde is not configured yet. Update assets/js/kinde-config.js with your Client ID and Kinde domain.");
    return;
  }

  kindeClient = await createKindeClient({
    client_id: kindeConfig.clientId,
    domain: kindeConfig.domain,
    redirect_uri: siteUrl,
    logout_uri: siteUrl,
    is_dangerously_use_local_storage: true,
    on_redirect_callback: function (_user, appState) {
      const redirectTo = getStoredRedirect(appState?.redirectTo);
      if (redirectTo && window.location.pathname !== redirectTo) {
        redirectingAfterAuth = true;
        window.location.replace(redirectTo);
      }
    }
  });

  if (redirectingAfterAuth) return;

  bindAuthButtons();
  await renderAuthState();
  if (await redirectAuthenticatedIntent()) return;
  if (await redirectAuthenticatedHome()) return;
  await protectCurrentPage();
  await syncAuthenticatedUser();
  await renderDashboardState();
  await renderAdminState();
}

function hasKindeConfig() {
  return Boolean(
    kindeConfig.clientId &&
    kindeConfig.domain &&
    !kindeConfig.clientId.includes("PASTE_") &&
    !kindeConfig.domain.includes("PASTE_")
  );
}

function bindAuthButtons() {
  const loginButton = document.getElementById("login");
  if (loginButton) {
    loginButton.addEventListener("click", async function (event) {
      event.preventDefault();
      await startAuthFlow("login", loginButton);
    });
  }

  const registerButton = document.getElementById("register");
  if (registerButton) {
    registerButton.addEventListener("click", async function (event) {
      event.preventDefault();
      await startAuthFlow("register", registerButton);
    });
  }

  document.querySelectorAll("[data-kinde-login]").forEach(function (element) {
    if (element.id === "login") return;

    element.addEventListener("click", async function (event) {
      event.preventDefault();
      await startAuthFlow("login", element);
    });
  });

  document.querySelectorAll("[data-kinde-register]").forEach(function (element) {
    if (element.id === "register") return;

    element.addEventListener("click", async function (event) {
      event.preventDefault();
      await startAuthFlow("register", element);
    });
  });

  document.querySelectorAll("[data-kinde-logout]").forEach(function (element) {
    element.addEventListener("click", function (event) {
      event.preventDefault();
      kindeClient.logout();
    });
  });
}

async function startAuthFlow(type, element) {
  if (authFlowStarting) return;
  authFlowStarting = true;
  if (element) element.dataset.authStarting = "true";

  try {
    const checkoutPlan = normalizePlanKey(element?.getAttribute("data-checkout-plan"));
    const redirectTo = checkoutPlan
      ? dashboardPath
      : normalizeRedirectPath(element?.getAttribute("data-redirect-to")) || dashboardPath;
    const isAuthenticated = await kindeClient.isAuthenticated();

    if (isAuthenticated) {
      if (checkoutPlan) storeCheckoutIntent(checkoutPlan);
      window.location.assign(redirectTo);
      return;
    }

    storeRedirect(redirectTo);
    storeAuthIntent(redirectTo);
    if (checkoutPlan) storeCheckoutIntent(checkoutPlan);
    setButtonEnabled(element, false);
    const options = { app_state: { redirectTo } };

    if (type === "login") {
      await kindeClient.login(options);
      return;
    }

    await kindeClient.register(options);
  } catch (error) {
    authFlowStarting = false;
    if (element) delete element.dataset.authStarting;
    setButtonEnabled(element, true);
    throw error;
  }
}

async function redirectAuthenticatedIntent() {
  const redirectTo = readAuthIntentRedirect();
  if (!redirectTo || window.location.pathname === redirectTo) return false;
  const isAuthenticated = await kindeClient.isAuthenticated();
  if (!isAuthenticated) return false;

  clearAuthIntent();
  window.location.replace(redirectTo);
  return true;
}

async function redirectAuthenticatedHome() {
  if (!isHomePage()) return false;
  const isAuthenticated = await kindeClient.isAuthenticated();
  if (!isAuthenticated) return false;

  window.location.replace(dashboardPath);
  return true;
}

function storeRedirect(redirectTo) {
  try {
    window.sessionStorage.setItem(redirectStorageKey, redirectTo);
  } catch (_error) {
    // Session storage can be unavailable in strict browser modes.
  }
}

function storeAuthIntent(redirectTo) {
  try {
    window.localStorage.setItem(authIntentStorageKey, JSON.stringify({
      redirectTo,
      createdAt: Date.now()
    }));
  } catch (_error) {
    // Local storage is only a redirect hint; login still works without it.
  }
}

function getStoredRedirect(primaryRedirect) {
  const redirectTo = normalizeRedirectPath(primaryRedirect) || readStoredRedirect() || readAuthIntentRedirect();
  try {
    window.sessionStorage.removeItem(redirectStorageKey);
    clearAuthIntent();
  } catch (_error) {
    // Nothing to clean up when storage is blocked.
  }
  return redirectTo;
}

function readStoredRedirect() {
  try {
    return normalizeRedirectPath(window.sessionStorage.getItem(redirectStorageKey));
  } catch (_error) {
    return "";
  }
}

function readAuthIntentRedirect() {
  try {
    const intent = JSON.parse(window.localStorage.getItem(authIntentStorageKey) || "null");
    if (!intent || Date.now() - Number(intent.createdAt || 0) > 10 * 60 * 1000) {
      window.localStorage.removeItem(authIntentStorageKey);
      return "";
    }
    return normalizeRedirectPath(intent.redirectTo);
  } catch (_error) {
    return "";
  }
}

function clearAuthIntent() {
  try {
    window.localStorage.removeItem(authIntentStorageKey);
  } catch (_error) {
    // Nothing to clear when storage is blocked.
  }
}

function storeCheckoutIntent(planKey) {
  try {
    window.localStorage.setItem(checkoutIntentStorageKey, JSON.stringify({
      plan: planKey,
      createdAt: Date.now()
    }));
  } catch (_error) {
    // Checkout intent only helps continue after login.
  }
}

function readCheckoutIntent() {
  try {
    const intent = JSON.parse(window.localStorage.getItem(checkoutIntentStorageKey) || "null");
    if (!intent || Date.now() - Number(intent.createdAt || 0) > 10 * 60 * 1000) {
      window.localStorage.removeItem(checkoutIntentStorageKey);
      return "";
    }
    return normalizePlanKey(intent.plan);
  } catch (_error) {
    return "";
  }
}

function clearCheckoutIntent() {
  try {
    window.localStorage.removeItem(checkoutIntentStorageKey);
  } catch (_error) {
    // Nothing to clear when storage is blocked.
  }
}

function normalizePlanKey(value) {
  const planKey = String(value || "").trim().toLowerCase();
  return ["basic", "pro"].includes(planKey) ? planKey : "";
}

function normalizeRedirectPath(value) {
  if (!value) return "";
  const redirectTo = String(value).trim();
  if (!redirectTo.startsWith("/") || redirectTo.startsWith("//")) return "";
  return redirectTo;
}

function isHomePage() {
  return window.location.pathname === "/" || window.location.pathname === "/index.html";
}

async function renderAuthState() {
  const isAuthenticated = await kindeClient.isAuthenticated();
  const user = isAuthenticated ? await kindeClient.getUser() : null;

  document.querySelectorAll("[data-auth-guest]").forEach(function (element) {
    element.classList.toggle("hidden", isAuthenticated);
  });

  document.querySelectorAll("[data-auth-user]").forEach(function (element) {
    element.classList.toggle("hidden", !isAuthenticated);
  });

  document.querySelectorAll("[data-user-email]").forEach(function (element) {
    element.textContent = user?.email || user?.given_name || "Signed in";
  });
}

async function protectCurrentPage() {
  if (!document.body.hasAttribute("data-protected-page")) return;

  const isAuthenticated = await kindeClient.isAuthenticated();
  if (!isAuthenticated) {
    showProtectedLoginRequired();
    throw new Error("Authentication is required for this page.");
  }
}

function showProtectedLoginRequired() {
  const errorElement = document.querySelector("[data-dashboard-error]");
  const accessElement = document.querySelector("[data-dashboard-access]");
  const statusElement = document.querySelector("[data-billing-status]");
  const subscribeButton = document.querySelector("[data-subscribe-basic]");

  setText(statusElement, "Login required");
  setText(accessElement, "Please log in to continue.");
  setText(errorElement, "Login did not complete in this browser session. Return home, refresh once, and log in again.");
  setButtonEnabled(subscribeButton, false);
}

async function syncAuthenticatedUser() {
  const isAuthenticated = await kindeClient.isAuthenticated();
  if (!isAuthenticated) return;

  try {
    await apiFetch("/api/auth/sync-user", { method: "POST" });
  } catch (error) {
    console.error("Backend user sync failed:", error);
  }
}

async function renderDashboardState() {
  if (!document.body.hasAttribute("data-dashboard-page")) return;

  const statusElement = document.querySelector("[data-billing-status]");
  const planElement = document.querySelector("[data-plan-name]");
  const accessElement = document.querySelector("[data-dashboard-access]");
  const subscribeButton = document.querySelector("[data-subscribe-basic]");
  const upgradeButton = document.querySelector("[data-subscribe-pro]");
  const cancelButton = document.querySelector("[data-cancel-basic]");
  const errorElement = document.querySelector("[data-dashboard-error]");

  try {
    const account = await apiFetch("/api/me");
    currentAccount = account;
    const billing = await apiFetch("/api/billing/status");
    currentBilling = billing;

    const paymentState = billing.payment_state || (billing.active ? "active" : "trial");
    const activePlanKey = planKeyFromBilling(billing);
    setText(statusElement, billingStatusLabel(paymentState, billing.plan?.name));
    setText(planElement, billing.plan ? `${billing.plan.name} - ₹${billing.plan.price_inr}/${billing.plan.billing_interval}` : "Basic - ₹350/month");
    setText(accessElement, billingAccessLabel(paymentState, billing.dashboard_access_allowed, billing.plan?.name));
    setButtonEnabled(subscribeButton, !billing.active && !billing.checkout_pending);
    if (subscribeButton) subscribeButton.classList.toggle("hidden", Boolean(billing.active));
    if (subscribeButton) subscribeButton.textContent = billingButtonLabel(paymentState, billing.checkout_pending);
    setUpgradeButtonState(upgradeButton, billing, activePlanKey);
    setCancelButtonVisible(cancelButton, billing.active && paymentState !== "cancel_requested");
    setDashboardSetupVisible(Boolean(billing.active));
    setWebsiteCrawlingEnabled(Boolean(billing.entitlement?.websiteCrawling));

    document.querySelectorAll("[data-company-name]").forEach(function (element) {
      element.textContent = account.tenant?.company_name || "Your company";
    });

    if (billing.active) {
      renderWebsiteUrl(account);
      renderEmbedScript(account);
      await renderDocuments();
      await renderWebsitePages();
    }

    await continuePendingCheckoutIntent(billing);
  } catch (error) {
    console.error("Dashboard load failed:", error);
    setText(statusElement, "Backend offline");
    setText(planElement, "Basic - ₹350/month");
    setText(accessElement, "Checkout is unavailable until the backend API is online.");
    setText(errorElement, "Backend API is not reachable at the configured URL. Deploy the backend or update productionBackendUrl.");
    setDashboardSetupVisible(false);
    setWebsiteCrawlingEnabled(false);
    setButtonEnabled(subscribeButton, false);
    setButtonEnabled(upgradeButton, false);
    if (upgradeButton) upgradeButton.classList.add("hidden");
    setCancelButtonVisible(cancelButton, false);
  }
}

document.addEventListener("click", async function (event) {
  const adminRefresh = event.target.closest("[data-admin-refresh]");
  if (adminRefresh) {
    event.preventDefault();
    await renderAdminState();
    return;
  }

  const adminRetryStuck = event.target.closest("[data-admin-retry-stuck]");
  if (adminRetryStuck) {
    event.preventDefault();
    if (adminRetryStuck.disabled) return;

    const statusElement = document.querySelector("[data-admin-status]");
    setButtonEnabled(adminRetryStuck, false);
    setText(statusElement, "Checking for stuck PDFs...");

    try {
      const result = await apiFetch("/api/admin/documents/retry-stuck", { method: "POST" });
      setText(statusElement, result.queued
        ? `Retry queued for ${result.queued} stuck PDF(s). Refresh in a minute.`
        : "No stuck PDFs found."
      );
    } catch (error) {
      console.error("Stuck PDF retry failed:", error);
      setText(statusElement, error.message || "Could not retry stuck PDFs.");
    } finally {
      setButtonEnabled(adminRetryStuck, true);
    }
    return;
  }

  const cancelButton = event.target.closest("[data-cancel-basic]");
  if (cancelButton) {
    event.preventDefault();
    if (cancelButton.disabled) return;

    const planName = currentBilling?.plan?.name || "current";
    if (!window.confirm(`Cancel future billing for the ${planName} plan? Your plan stays active until the current billing cycle ends.`)) {
      return;
    }

    const statusElement = document.querySelector("[data-dashboard-error]");
    setButtonEnabled(cancelButton, false);
    cancelButton.textContent = "Cancelling...";
    setText(statusElement, "Cancelling future billing...");

    try {
      await apiFetch("/api/billing/cancel-subscription", { method: "POST" });
      setText(statusElement, `Future billing is cancelled. ${planName} stays active until the current billing cycle ends.`);
      await renderDashboardState();
    } catch (error) {
      console.error("Subscription cancellation failed:", error);
      setText(statusElement, error.message || "Could not cancel future billing. Please contact support.");
      setButtonEnabled(cancelButton, true);
      cancelButton.textContent = "Cancel future billing";
    }
    return;
  }

  const subscribeButton = event.target.closest("[data-subscribe-plan]");
  if (!subscribeButton) return;

  event.preventDefault();
  if (subscribeButton.disabled) return;

  const planKey = subscribeButton.getAttribute("data-subscribe-plan") || "basic";
  await startCheckout(planKey, subscribeButton);
});

async function continuePendingCheckoutIntent(billing) {
  if (!document.body.hasAttribute("data-dashboard-page")) return;

  const planKey = readCheckoutIntent();
  if (!planKey) return;

  const activePlanKey = planKeyFromBilling(billing);
  const paymentState = billing.payment_state || (billing.active ? "active" : "trial");
  const statusElement = document.querySelector("[data-dashboard-error]");

  if (billing.active && activePlanKey === planKey && paymentState !== "payment_failed") {
    clearCheckoutIntent();
    setText(statusElement, `${billing.plan?.name || planKey} is already active.`);
    return;
  }

  clearCheckoutIntent();
  const subscribeButton = document.querySelector(`[data-subscribe-plan="${planKey}"]`);
  await startCheckout(planKey, subscribeButton);
}

async function startCheckout(planKey, subscribeButton) {
  const normalizedPlanKey = normalizePlanKey(planKey) || "basic";
  const statusElement = document.querySelector("[data-dashboard-error]");

  setButtonEnabled(subscribeButton, false);
  if (subscribeButton) subscribeButton.textContent = "Preparing checkout...";
  setText(statusElement, "Creating Razorpay subscription...");

  try {
    const data = await apiFetch("/api/billing/create-subscription", {
      method: "POST",
      body: JSON.stringify({ plan: normalizedPlanKey })
    });
    openRazorpayCheckout(data.checkout, subscribeButton);
    setText(statusElement, "Checkout opened. Complete the Razorpay payment.");
  } catch (error) {
    console.error("Subscription creation failed:", error);
    setText(statusElement, error.message || "Could not start checkout. Confirm Razorpay env values and the plan id.");
    setButtonEnabled(subscribeButton, true);
    resetCheckoutButton(subscribeButton);
  }
}

document.addEventListener("submit", async function (event) {
  const websiteForm = event.target.closest("[data-website-url-form]");
  if (!websiteForm) return;

  event.preventDefault();
  if (websiteForm.dataset.saving === "true") return;

  const input = websiteForm.querySelector("[data-website-url-input]");
  const statusElement = document.querySelector("[data-website-url-status]");
  const button = websiteForm.querySelector("button[type='submit']");

  websiteForm.dataset.saving = "true";
  setButtonEnabled(button, false);
  setText(statusElement, "Saving website URL...");

  try {
    const account = await apiFetch("/api/me/chatbot-settings", {
      method: "PATCH",
      body: JSON.stringify({
        website_url: input?.value || ""
      })
    });
    currentAccount = account;
    renderWebsiteUrl(account);
    renderEmbedScript(account);
    setText(statusElement, account.tenant?.website_url ? "Website URL saved." : "Website URL cleared.");
  } catch (error) {
    console.error("Website URL save failed:", error);
    setText(statusElement, error.message || "Could not save website URL.");
  } finally {
    delete websiteForm.dataset.saving;
    setButtonEnabled(button, true);
  }
});

document.addEventListener("submit", async function (event) {
  const form = event.target.closest("[data-pdf-upload-form]");
  if (!form) return;

  event.preventDefault();
  if (form.dataset.uploading === "true") return;

  const input = form.querySelector("[data-pdf-input]");
  const file = input?.files?.[0];
  const statusElement = document.querySelector("[data-documents-status]");
  const button = form.querySelector("button[type='submit']");

  if (!file) {
    setText(statusElement, "Choose a PDF first.");
    return;
  }

  const body = new FormData();
  body.append("pdf", file);

  form.dataset.uploading = "true";
  setButtonEnabled(button, false);
  setText(statusElement, "Uploading PDF...");

  try {
    await apiFetch("/api/documents/upload", {
      method: "POST",
      body
    });
    input.value = "";
    setText(statusElement, "PDF uploaded. Processing has started.");
    await renderDocuments();
    pollDocumentsWhileProcessing();
  } catch (error) {
    console.error("PDF upload failed:", error);
    setText(statusElement, error.message || "PDF upload failed.");
  } finally {
    delete form.dataset.uploading;
    setButtonEnabled(button, true);
  }
});

document.addEventListener("click", async function (event) {
  const deleteButton = event.target.closest("[data-delete-document]");
  if (!deleteButton) return;

  event.preventDefault();
  if (deleteButton.disabled) return;

  const id = deleteButton.getAttribute("data-delete-document");
  const statusElement = document.querySelector("[data-documents-status]");
  setButtonEnabled(deleteButton, false);
  setText(statusElement, "Deleting document...");

  try {
    await apiFetch(`/api/documents/${id}`, { method: "DELETE" });
    setText(statusElement, "Document deleted.");
    await renderDocuments();
  } catch (error) {
    console.error("Document delete failed:", error);
    setText(statusElement, error.message || "Document delete failed.");
    setButtonEnabled(deleteButton, true);
  }
});

document.addEventListener("click", async function (event) {
  const scanButton = event.target.closest("[data-scan-website]");
  if (scanButton) {
    event.preventDefault();
    if (scanButton.disabled) return;

    const statusElement = document.querySelector("[data-website-pages-status]");
    const resultsElement = document.querySelector("[data-website-scan-results]");
    const crawlUrlInput = document.querySelector("[data-website-crawl-url-input]");
    const crawlUrl = crawlUrlInput?.value?.trim();

    if (!crawlUrl) {
      setText(statusElement, "Enter a website URL to scan.");
      return;
    }

    setButtonEnabled(scanButton, false);
    setText(statusElement, "Scanning public website pages...");
    if (resultsElement) {
      resultsElement.classList.add("hidden");
      resultsElement.innerHTML = "";
    }

    try {
      const data = await apiFetch("/api/website-pages/scan", {
        method: "POST",
        body: JSON.stringify({ url: crawlUrl })
      });
      renderWebsiteScanResults(data.pages || []);
      setText(statusElement, data.pages?.length ? "Select pages to add to chatbot knowledge." : "No public pages found.");
    } catch (error) {
      console.error("Website scan failed:", error);
      setText(statusElement, error.message || "Could not scan website pages.");
    } finally {
      setButtonEnabled(scanButton, true);
    }
    return;
  }

  const indexButton = event.target.closest("[data-index-website-pages]");
  if (indexButton) {
    event.preventDefault();
    if (indexButton.disabled) return;

    const resultsElement = document.querySelector("[data-website-scan-results]");
    const statusElement = document.querySelector("[data-website-pages-status]");
    const urls = Array.from(document.querySelectorAll("[data-website-page-choice]:checked"))
      .map((input) => input.value);

    if (!urls.length) {
      setText(statusElement, "Select at least one page.");
      return;
    }

    setButtonEnabled(indexButton, false);
    setText(statusElement, "Adding website pages to chatbot knowledge...");

    try {
      const data = await apiFetch("/api/website-pages/index", {
        method: "POST",
        body: JSON.stringify({ urls })
      });
      const indexedCount = data.indexed?.length || 0;
      const failedCount = data.failed?.length || 0;
      setText(statusElement, `Website knowledge updated. Indexed ${indexedCount} page(s). Failed ${failedCount} page(s).`);
      if (resultsElement) {
        resultsElement.classList.add("hidden");
        resultsElement.innerHTML = "";
      }
      await renderWebsitePages();
    } catch (error) {
      console.error("Website page indexing failed:", error);
      setText(statusElement, error.message || "Could not add website pages.");
    } finally {
      setButtonEnabled(indexButton, true);
    }
    return;
  }

  const deletePageButton = event.target.closest("[data-delete-website-page]");
  if (!deletePageButton) return;

  event.preventDefault();
  if (deletePageButton.disabled) return;

  const id = deletePageButton.getAttribute("data-delete-website-page");
  const statusElement = document.querySelector("[data-website-pages-status]");
  setButtonEnabled(deletePageButton, false);
  setText(statusElement, "Deleting website page knowledge...");

  try {
    await apiFetch(`/api/website-pages/${id}`, { method: "DELETE" });
    setText(statusElement, "Website page removed.");
    await renderWebsitePages();
  } catch (error) {
    console.error("Website page delete failed:", error);
    setText(statusElement, error.message || "Could not delete website page.");
    setButtonEnabled(deletePageButton, true);
  }
});

document.addEventListener("click", async function (event) {
  const copyButton = event.target.closest("[data-copy-script]");
  if (!copyButton) return;

  const textarea = document.querySelector("[data-embed-script]");
  if (!textarea?.value) return;

  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(textarea.value);
  } else {
    textarea.select();
    document.execCommand("copy");
  }
  copyButton.textContent = "Copied";
  window.setTimeout(function () {
    copyButton.textContent = "Copy script";
  }, 1600);
});

async function apiFetch(path, options = {}) {
  const token = await getBackendToken();
  const headers = {
    Authorization: `Bearer ${token}`,
    ...(options.headers || {})
  };

  if (!(options.body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(`${backendUrl}${path}`, {
    ...options,
    headers
  });

  const data = await response.json().catch(function () {
    return null;
  });

  if (!response.ok) {
    throw new Error(data?.error || `Request failed with ${response.status}`);
  }

  return data;
}

async function getBackendToken() {
  const accessToken = await kindeClient.getToken();
  if (isJwt(accessToken)) return accessToken;

  if (typeof kindeClient.getIdToken === "function") {
    const idToken = await kindeClient.getIdToken();
    if (isJwt(idToken)) return idToken;
  }

  return accessToken;
}

function isJwt(token) {
  return typeof token === "string" && token.split(".").length === 3;
}

async function renderDocuments() {
  if (!document.body.hasAttribute("data-dashboard-page")) return;

  const listElement = document.querySelector("[data-documents-list]");
  if (!listElement || !currentAccount) return;

  try {
    const data = await apiFetch("/api/documents");
    const documents = data.documents || [];

    if (!documents.length) {
      listElement.innerHTML = '<div class="px-4 py-4 text-slate-500">No PDFs uploaded yet.</div>';
      return documents;
    }

    listElement.innerHTML = documents.map(function (document) {
      const statusClass = document.status === "completed"
        ? "text-emerald-700"
        : document.status === "failed"
          ? "text-red-700"
          : "text-amber-700";
      const statusLabel = documentStatusLabel(document.status);
      const sourceLabel = document.source_type === "ocr"
        ? `OCR${document.ocr_confidence ? ` ${Math.round(Number(document.ocr_confidence))}%` : ""}`
        : document.source_type === "pdf_text"
          ? "PDF text"
          : "";

      return `
        <div class="grid gap-3 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_170px_80px] sm:items-center">
          <div class="min-w-0">
            <p class="truncate font-semibold">${escapeHtml(document.file_name)}</p>
            ${sourceLabel ? `<p class="mt-1 text-xs text-slate-500">${escapeHtml(sourceLabel)}</p>` : ""}
            ${document.error_message ? `<p class="mt-1 text-xs text-red-600">${escapeHtml(document.error_message)}</p>` : ""}
          </div>
          <span class="text-sm font-bold leading-5 ${statusClass}">${escapeHtml(statusLabel)}</span>
          <button type="button" data-delete-document="${document.id}" class="rounded-full border border-slate-200 px-3 py-1.5 text-xs font-bold">Delete</button>
        </div>
      `;
    }).join("");
    return documents;
  } catch (error) {
    console.error("Document list failed:", error);
    listElement.innerHTML = '<div class="px-4 py-4 text-red-600">Could not load documents.</div>';
    return [];
  }
}

async function renderWebsitePages() {
  if (!document.body.hasAttribute("data-dashboard-page")) return;

  const listElement = document.querySelector("[data-website-pages-list]");
  if (!listElement || !currentAccount) return;

  try {
    const data = await apiFetch("/api/website-pages");
    const pages = data.pages || [];
    renderWebsitePageUsage(pages);

    if (!pages.length) {
      listElement.innerHTML = '<div class="px-4 py-4 text-slate-500">No website pages added yet.</div>';
      return pages;
    }

    listElement.innerHTML = pages.map(function (page) {
      const statusClass = page.status === "indexed" ? "text-emerald-700" : "text-red-700";
      const label = page.status === "indexed" ? "Indexed" : "Failed";
      const title = page.title || page.url;

      return `
        <div class="grid gap-3 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_110px_80px] sm:items-center">
          <div class="min-w-0">
            <p class="truncate font-semibold">${escapeHtml(title)}</p>
            <p class="mt-1 truncate text-xs text-slate-500">${escapeHtml(page.url)}</p>
            ${page.error_message ? `<p class="mt-1 text-xs text-red-600">${escapeHtml(page.error_message)}</p>` : ""}
          </div>
          <span class="text-sm font-bold leading-5 ${statusClass}">${escapeHtml(label)}</span>
          <button type="button" data-delete-website-page="${page.id}" class="rounded-full border border-slate-200 px-3 py-1.5 text-xs font-bold">Delete</button>
        </div>
      `;
    }).join("");
    return pages;
  } catch (error) {
    console.error("Website pages list failed:", error);
    renderWebsitePageUsage([]);
    listElement.innerHTML = '<div class="px-4 py-4 text-red-600">Could not load website pages.</div>';
    return [];
  }
}

function renderWebsitePageUsage(pages) {
  const usageElement = document.querySelector("[data-website-pages-usage]");
  if (!usageElement) return;

  const limit = Number(currentBilling?.entitlement?.websitePageLimit || 0);
  const used = (pages || []).filter((page) => page.status === "indexed").length;

  if (!limit) {
    usageElement.textContent = "";
    usageElement.className = "hidden";
    return;
  }

  const remaining = Math.max(0, limit - used);
  if (used < 25) {
    usageElement.textContent = "";
    usageElement.className = "hidden";
    return;
  }

  usageElement.textContent = `Website pages: ${used}/${limit}. ${remaining} page(s) left.`;
  usageElement.className = "mt-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-bold text-amber-800";
}

function renderWebsiteScanResults(pages) {
  const resultsElement = document.querySelector("[data-website-scan-results]");
  if (!resultsElement) return;

  if (!pages.length) {
    resultsElement.classList.add("hidden");
    resultsElement.innerHTML = "";
    return;
  }

  resultsElement.classList.remove("hidden");
  resultsElement.innerHTML = `
    <div class="flex flex-col gap-3">
      <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p class="text-sm font-bold text-slate-900">Found ${pages.length} public page(s)</p>
        <button type="button" data-index-website-pages class="rounded-full bg-[#c96f4a] px-5 py-2.5 text-sm font-bold text-white">
          Add selected pages
        </button>
      </div>
      <div class="grid gap-2">
        ${pages.map(function (page, index) {
          return `
            <label class="flex items-start gap-3 rounded-lg border border-slate-200 bg-white p-3 text-sm">
              <input type="checkbox" class="mt-1" data-website-page-choice value="${escapeAttr(page.url)}" ${index < 5 ? "checked" : ""}>
              <span class="min-w-0 flex-1 break-words text-slate-700">${escapeHtml(page.url)}</span>
            </label>
          `;
        }).join("")}
      </div>
    </div>
  `;
}

async function renderAdminState() {
  if (!document.body.hasAttribute("data-admin-page")) return;

  const statusElement = document.querySelector("[data-admin-status]");
  const summaryElement = document.querySelector("[data-admin-summary]");

  setText(statusElement, "Loading admin data...");

  try {
    const data = await apiFetch("/api/admin/overview");
    const summary = data.summary || {};

    if (summaryElement) {
      summaryElement.innerHTML = [
        summaryCard("Users", summary.users),
        summaryCard("Active subscriptions", summary.active_subscriptions),
        summaryCard("PDFs", summary.documents),
        summaryCard("Failed PDFs", summary.failed_documents),
        summaryCard("Leads", summary.leads)
      ].join("");
    }

    renderAdminTable("leads", "Fallback leads", data.leads || [], [
      ["created_at", "Created"],
      ["client_email", "Client"],
      ["name", "Name"],
      ["email", "Lead email"],
      ["phone", "Phone"],
      ["question", "Question"]
    ]);
    renderAdminTable("subscriptions", "Subscriptions", data.subscriptions || [], [
      ["updated_at", "Updated"],
      ["email", "Client"],
      ["company_name", "Company"],
      ["plan_name", "Plan"],
      ["status", "Status"],
      ["razorpay_subscription_id", "Razorpay ID"]
    ]);
    renderAdminTable("documents", "PDFs and OCR", data.documents || [], [
      ["created_at", "Created"],
      ["email", "Client"],
      ["file_name", "File"],
      ["status", "Status"],
      ["source_type", "Source"],
      ["error_message", "Error"]
    ]);
    renderAdminTable("usage", "Usage", data.usage || [], [
      ["month", "Month"],
      ["email", "Client"],
      ["pdf_uploaded_count", "PDF count"],
      ["chatbot_messages_count", "Messages"],
      ["token_used", "Tokens"],
      ["updated_at", "Updated"]
    ]);
    renderAdminTable("users", "Users", data.users || [], [
      ["created_at", "Created"],
      ["email", "Email"],
      ["full_name", "Name"],
      ["company_name", "Company"],
      ["current_plan", "Plan"]
    ]);

    setText(statusElement, "Admin data loaded. Showing the latest 50 rows per section.");
  } catch (error) {
    console.error("Admin load failed:", error);
    setText(statusElement, error.message || "Could not load admin data.");
    if (summaryElement) summaryElement.innerHTML = "";
  }
}

function summaryCard(label, value) {
  return `
    <article class="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <p class="text-sm font-bold text-slate-500">${escapeHtml(label)}</p>
      <p class="mt-2 text-3xl font-bold">${escapeHtml(value ?? 0)}</p>
    </article>
  `;
}

function renderAdminTable(key, title, rows, columns) {
  const host = document.querySelector(`[data-admin-table="${key}"]`);
  if (!host) return;

  const header = columns.map(function ([, label]) {
    return `<th class="whitespace-nowrap px-3 py-2 text-left text-xs font-bold uppercase tracking-wide text-slate-500">${escapeHtml(label)}</th>`;
  }).join("");

  const body = rows.length
    ? rows.map(function (row) {
        return `
          <tr class="border-t border-slate-100">
            ${columns.map(function ([field]) {
              return `<td class="max-w-[260px] truncate px-3 py-2 text-sm text-slate-700" title="${escapeAttr(row[field] ?? "")}">${escapeHtml(formatAdminValue(row[field]))}</td>`;
            }).join("")}
          </tr>
        `;
      }).join("")
    : `<tr><td colspan="${columns.length}" class="border-t border-slate-100 px-3 py-4 text-sm text-slate-500">No rows yet.</td></tr>`;

  host.innerHTML = `
    <section class="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <div class="border-b border-slate-200 px-4 py-3">
        <h2 class="text-lg font-bold">${escapeHtml(title)}</h2>
      </div>
      <div class="overflow-x-auto">
        <table class="min-w-full">
          <thead class="bg-slate-50"><tr>${header}</tr></thead>
          <tbody>${body}</tbody>
        </table>
      </div>
    </section>
  `;
}

function formatAdminValue(value) {
  if (value === null || value === undefined || value === "") return "-";
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
    return new Date(value).toLocaleString();
  }
  return value;
}

function documentStatusLabel(status) {
  const labels = {
    uploading_pdf: "Uploading PDF",
    extracting_pdf_text: "Extracting PDF text",
    scanned_pdf_detected: "Scanned PDF detected",
    running_ocr: "Running OCR",
    creating_chunks: "Creating chunks",
    saving_knowledge_base: "Saving knowledge base",
    completed: "Completed",
    failed: "Failed"
  };

  return labels[status] || status || "Unknown";
}

function billingStatusLabel(state, planName) {
  const activePlanName = planName || "Basic";
  const labels = {
    trial: "Basic not active",
    active: `${activePlanName} active`,
    cancel_requested: "Cancellation scheduled",
    payment_failed: "Payment failed",
    cancelled: "Cancelled"
  };

  return labels[state] || "Basic not active";
}

function billingAccessLabel(state, accessAllowed, planName) {
  const activePlanName = planName || "Basic";
  if (state === "cancel_requested") return `Future billing is cancelled. ${activePlanName} stays active until the current billing cycle ends.`;
  if (accessAllowed) return `${activePlanName} plan limits are active`;
  if (state === "payment_failed") return `Payment failed. ${activePlanName} features are locked until payment is restored.`;
  if (state === "cancelled") return "Subscription cancelled. Paid features are locked.";
  return "Start Basic to unlock uploads and chatbot setup.";
}

function billingButtonLabel(state, checkoutPending) {
  if (state === "active") return "Basic active";
  if (state === "cancel_requested") return "Basic active";
  if (checkoutPending) return "Activation pending";
  if (state === "payment_failed") return "Retry ₹350/month payment";
  if (state === "cancelled") return "Restart Basic - ₹350/month";
  return "Start Basic - ₹350/month";
}

function setUpgradeButtonState(button, billing, activePlanKey) {
  if (!button) return;

  const canUpgrade = Boolean(billing.active) && activePlanKey === "basic" && !billing.checkout_pending;
  button.classList.toggle("hidden", !canUpgrade);
  button.textContent = canUpgrade ? "Upgrade to Pro - INR 500/month" : "Pro active";
  setButtonEnabled(button, canUpgrade);
}

function planKeyFromBilling(billing) {
  const planName = String(billing?.plan?.name || billing?.subscription?.plan_name || "").toLowerCase();
  return planName.includes("pro") ? "pro" : "basic";
}

function resetCheckoutButton(button) {
  if (!button) return;

  if ((button.getAttribute("data-subscribe-plan") || "basic") === "pro") {
    button.textContent = "Upgrade to Pro - INR 500/month";
    return;
  }

  button.textContent = "Start Basic - ₹350/month";
}

function pollDocumentsWhileProcessing() {
  let attempts = 0;
  const maxAttempts = 240;

  async function tick() {
    attempts += 1;
    const documents = await renderDocuments() || [];
    const hasProcessingDocument = documents.some(function (document) {
      return isProcessingDocumentStatus(document.status);
    });

    if (hasProcessingDocument && attempts < maxAttempts) {
      window.setTimeout(tick, 3000);
    }
  }

  window.setTimeout(tick, 3000);
}

function isProcessingDocumentStatus(status) {
  return [
    "uploading_pdf",
    "extracting_pdf_text",
    "scanned_pdf_detected",
    "running_ocr",
    "creating_chunks",
    "saving_knowledge_base"
  ].includes(status);
}

function renderEmbedScript(account) {
  const textarea = document.querySelector("[data-embed-script]");
  const preview = document.querySelector("[data-widget-preview]");
  if (!textarea) return;

  const clientId = account.client?.id || account.tenant?.id || "CLIENT_ID";
  const chatbotKey = account.chatbot?.public_embed_key || account.chatbot_settings?.public_embed_key || "CHATBOT_KEY";
  const script = `<script src="${backendUrl}/widget.js" data-client-id="${clientId}" data-chatbot-key="${chatbotKey}"></script>`;
  textarea.value = script;

  if (preview) {
    preview.srcdoc = `
      <!doctype html>
      <html>
        <head>
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <style>
            body { margin: 0; min-height: 320px; font-family: Arial, sans-serif; background: #f8fafc; color: #334155; }
            .preview-shell { padding: 18px; }
            .preview-shell h3 { margin: 0 0 8px; font-size: 16px; color: #0f172a; }
            .preview-shell p { margin: 0; max-width: 260px; font-size: 13px; line-height: 1.5; }
          </style>
        </head>
        <body>
          <div class="preview-shell">
            <h3>Your website preview</h3>
            <p>The launcher appears in the bottom-right corner, just like it will on a client site.</p>
          </div>
          ${script}
        </body>
      </html>
    `;
  }
}

function renderWebsiteUrl(account) {
  const input = document.querySelector("[data-website-url-input]");
  const crawlInput = document.querySelector("[data-website-crawl-url-input]");
  const statusElement = document.querySelector("[data-website-url-status]");
  if (!input) return;

  input.value = account.tenant?.website_url || account.chatbot_settings?.website_url || "";
  if (crawlInput && !crawlInput.value) crawlInput.value = input.value;
  setText(statusElement, input.value ? "Only this origin can use your chatbot." : "Set this before installing the widget.");
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, "&#096;");
}

function openRazorpayCheckout(checkout, subscribeButton) {
  if (!window.Razorpay) {
    throw new Error("Razorpay Checkout script is not loaded");
  }

  const razorpay = new window.Razorpay({
    key: checkout.key,
    subscription_id: checkout.subscription_id,
    name: checkout.name,
    description: checkout.description,
    prefill: checkout.prefill || {},
    handler: async function (response) {
      try {
        await apiFetch("/api/billing/verify-checkout", {
          method: "POST",
          body: JSON.stringify(response)
        });
        await renderDashboardState();
      } catch (error) {
        console.error("Razorpay checkout verification failed:", error);
        const errorElement = document.querySelector("[data-dashboard-error]");
        setText(errorElement, "Payment signature could not be verified. Please contact support before retrying.");
        setButtonEnabled(subscribeButton, true);
        resetCheckoutButton(subscribeButton);
      }
    },
    modal: {
      ondismiss: function () {
        setButtonEnabled(subscribeButton, true);
        resetCheckoutButton(subscribeButton);
      }
    }
  });

  razorpay.open();
}

function setText(element, value) {
  if (element) element.textContent = value;
}

function setButtonEnabled(button, enabled) {
  if (!button) return;
  button.disabled = !enabled;
  button.classList.toggle("opacity-60", !enabled);
  button.classList.toggle("cursor-not-allowed", !enabled);
}

function setDashboardSetupVisible(visible) {
  document.querySelectorAll("[data-billing-setup]").forEach(function (element) {
    element.classList.toggle("hidden", !visible);
  });
}

function setWebsiteCrawlingEnabled(enabled) {
  const controls = document.querySelector("[data-website-crawling-controls]");
  const upgrade = document.querySelector("[data-website-crawling-upgrade]");
  const status = document.querySelector("[data-website-pages-status]");

  if (controls) {
    controls.querySelectorAll("input,button").forEach(function (element) {
      element.disabled = !enabled;
      element.classList.toggle("opacity-60", !enabled);
      element.classList.toggle("cursor-not-allowed", !enabled);
    });
  }

  if (upgrade) upgrade.classList.toggle("hidden", enabled);
  if (!enabled) setText(status, "Website crawling is available in Pro Plan.");
}

function setCancelButtonVisible(button, visible) {
  if (!button) return;
  button.classList.toggle("hidden", !visible);
  button.textContent = "Cancel future billing";
  setButtonEnabled(button, visible);
}
