import createKindeClient from "../vendor/kinde-auth-pkce-js.esm.js";
import { kindeConfig } from "./kinde-config.js";

const isLocalhost = ["localhost", "127.0.0.1"].includes(window.location.hostname);
const siteUrl = isLocalhost ? kindeConfig.localSiteUrl : kindeConfig.productionSiteUrl;
const backendUrl = (isLocalhost ? kindeConfig.localBackendUrl : kindeConfig.productionBackendUrl).replace(/\/$/, "");
const dashboardPath = "/dashboard.html";

let kindeClient;
let currentAccount;

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
    is_dangerously_use_local_storage: isLocalhost,
    on_redirect_callback: function (_user, appState) {
      if (appState?.redirectTo) {
        window.location.assign(appState.redirectTo);
      }
    }
  });

  bindAuthButtons();
  await renderAuthState();
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
      await kindeClient.login({
        app_state: { redirectTo: loginButton.getAttribute("data-redirect-to") || dashboardPath }
      });
    });
  }

  const registerButton = document.getElementById("register");
  if (registerButton) {
    registerButton.addEventListener("click", async function (event) {
      event.preventDefault();
      await kindeClient.register({
        app_state: { redirectTo: registerButton.getAttribute("data-redirect-to") || dashboardPath }
      });
    });
  }

  document.querySelectorAll("[data-kinde-login]").forEach(function (element) {
    if (element.id === "login") return;

    element.addEventListener("click", function (event) {
      event.preventDefault();
      kindeClient.login({
        app_state: { redirectTo: element.getAttribute("data-redirect-to") || dashboardPath }
      });
    });
  });

  document.querySelectorAll("[data-kinde-register]").forEach(function (element) {
    if (element.id === "register") return;

    element.addEventListener("click", function (event) {
      event.preventDefault();
      kindeClient.register({
        app_state: { redirectTo: element.getAttribute("data-redirect-to") || dashboardPath }
      });
    });
  });

  document.querySelectorAll("[data-kinde-logout]").forEach(function (element) {
    element.addEventListener("click", function (event) {
      event.preventDefault();
      kindeClient.logout();
    });
  });
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
    await kindeClient.login({
      app_state: { redirectTo: window.location.pathname }
    });
  }
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
  const errorElement = document.querySelector("[data-dashboard-error]");

  try {
    const account = await apiFetch("/api/me");
    currentAccount = account;
    const billing = await apiFetch("/api/billing/status");

    const paymentState = billing.payment_state || (billing.active ? "active" : "trial");
    setText(statusElement, billingStatusLabel(paymentState));
    setText(planElement, billing.plan ? `${billing.plan.name} - ₹${billing.plan.price_inr}/${billing.plan.billing_interval}` : "Basic - ₹350/month");
    setText(accessElement, billingAccessLabel(paymentState, billing.dashboard_access_allowed));
    setButtonEnabled(subscribeButton, !billing.active && !billing.checkout_pending);
    if (subscribeButton) subscribeButton.textContent = billingButtonLabel(paymentState, billing.checkout_pending);

    document.querySelectorAll("[data-company-name]").forEach(function (element) {
      element.textContent = account.tenant?.company_name || "Your company";
    });

    renderWebsiteUrl(account);
    renderEmbedScript(account);
    await renderDocuments();
  } catch (error) {
    console.error("Dashboard load failed:", error);
    setText(errorElement, "Backend is not ready yet. Check backend server, database, and auth settings.");
    setButtonEnabled(subscribeButton, false);
  }
}

document.addEventListener("click", async function (event) {
  const adminRefresh = event.target.closest("[data-admin-refresh]");
  if (adminRefresh) {
    event.preventDefault();
    await renderAdminState();
    return;
  }

  const subscribeButton = event.target.closest("[data-subscribe-basic]");
  if (!subscribeButton) return;

  event.preventDefault();
  const statusElement = document.querySelector("[data-dashboard-error]");
  setButtonEnabled(subscribeButton, false);
  subscribeButton.textContent = "Preparing checkout...";
  setText(statusElement, "Creating Razorpay subscription...");

  try {
    const data = await apiFetch("/api/billing/create-subscription", { method: "POST" });
    openRazorpayCheckout(data.checkout, subscribeButton);
    setText(statusElement, "Checkout opened. Complete the Razorpay payment.");
  } catch (error) {
    console.error("Subscription creation failed:", error);
    setText(statusElement, error.message || "Could not start checkout. Confirm Razorpay env values and the Basic plan id.");
    setButtonEnabled(subscribeButton, true);
    subscribeButton.textContent = "Upgrade to Basic";
  }
});

document.addEventListener("submit", async function (event) {
  const websiteForm = event.target.closest("[data-website-url-form]");
  if (!websiteForm) return;

  event.preventDefault();
  const input = websiteForm.querySelector("[data-website-url-input]");
  const statusElement = document.querySelector("[data-website-url-status]");
  const button = websiteForm.querySelector("button[type='submit']");

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
    setButtonEnabled(button, true);
  }
});

document.addEventListener("submit", async function (event) {
  const form = event.target.closest("[data-pdf-upload-form]");
  if (!form) return;

  event.preventDefault();
  const input = form.querySelector("[data-pdf-input]");
  const file = input?.files?.[0];
  const statusElement = document.querySelector("[data-documents-status]");

  if (!file) {
    setText(statusElement, "Choose a PDF first.");
    return;
  }

  const body = new FormData();
  body.append("pdf", file);

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
  }
});

document.addEventListener("click", async function (event) {
  const deleteButton = event.target.closest("[data-delete-document]");
  if (!deleteButton) return;

  event.preventDefault();
  const id = deleteButton.getAttribute("data-delete-document");
  const statusElement = document.querySelector("[data-documents-status]");
  deleteButton.disabled = true;
  setText(statusElement, "Deleting document...");

  try {
    await apiFetch(`/api/documents/${id}`, { method: "DELETE" });
    setText(statusElement, "Document deleted.");
    await renderDocuments();
  } catch (error) {
    console.error("Document delete failed:", error);
    setText(statusElement, error.message || "Document delete failed.");
    deleteButton.disabled = false;
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

function billingStatusLabel(state) {
  const labels = {
    trial: "Trial",
    active: "Active",
    payment_failed: "Payment failed",
    cancelled: "Cancelled"
  };

  return labels[state] || "Trial";
}

function billingAccessLabel(state, accessAllowed) {
  if (accessAllowed) return "Basic plan limits are active";
  if (state === "payment_failed") return "Payment failed. Trial limits apply until payment is restored.";
  if (state === "cancelled") return "Subscription cancelled. Trial limits apply.";
  return "Trial limits apply until Basic is active";
}

function billingButtonLabel(state, checkoutPending) {
  if (state === "active") return "Basic active";
  if (checkoutPending) return "Activation pending";
  if (state === "payment_failed") return "Retry Basic payment";
  if (state === "cancelled") return "Upgrade to Basic again";
  return "Upgrade to Basic";
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
  const statusElement = document.querySelector("[data-website-url-status]");
  if (!input) return;

  input.value = account.tenant?.website_url || account.chatbot_settings?.website_url || "";
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
        if (subscribeButton) subscribeButton.textContent = "Upgrade to Basic";
      }
    },
    modal: {
      ondismiss: function () {
        setButtonEnabled(subscribeButton, true);
        if (subscribeButton) subscribeButton.textContent = "Upgrade to Basic";
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
