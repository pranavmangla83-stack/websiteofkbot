(function () {
  "use strict";

  var script = document.currentScript;
  if (!script || script.dataset.caicLoaded === "true") return;
  script.dataset.caicLoaded = "true";

  var clientId = clean(script.getAttribute("data-client-id"), 80);
  var chatbotKey = clean(script.getAttribute("data-chatbot-key"), 80);
  if (!clientId || !chatbotKey || document.getElementById("caic-widget-host-" + clientId)) return;

  var apiBase = new URL(script.src).origin;
  var position = script.getAttribute("data-position") === "left" ? "left" : "right";
  var title = clean(script.getAttribute("data-title"), 80) || "AI Assistant";
  var primaryColor = normalizeColor(script.getAttribute("data-primary-color")) || "#2563eb";
  var welcomeMessage = clean(script.getAttribute("data-welcome-message"), 220) || "Hi! How can I help you today?";
  var storagePrefix = "caic:" + clientId + ":";
  var sessionId = getOrCreateSession(storagePrefix + "session_id");
  var historyKey = storagePrefix + "history";
  var history = loadHistory(historyKey);
  var lastQuestion = "";
  var lastChatSessionId = "";

  function start() {
    var host = document.createElement("div");
    host.id = "caic-widget-host-" + clientId;
    host.style.position = "fixed";
    host.style[position] = "18px";
    host.style.bottom = "18px";
    host.style.zIndex = "2147483647";

    var root = host.attachShadow ? host.attachShadow({ mode: "open" }) : host;
    root.innerHTML =
      "<style>" + styles(position, primaryColor) + "</style>" +
      '<button class="bubble" type="button" aria-label="Open chat">' +
        '<span class="bubble-icon" aria-hidden="true">?</span>' +
      "</button>" +
      '<section class="panel" aria-label="' + escapeAttr(title) + '" aria-live="polite">' +
        '<header class="header">' +
          '<div><strong>' + escapeHtml(title) + '</strong><span>Usually replies instantly</span></div>' +
          '<button class="minimize" type="button" aria-label="Minimize chat">x</button>' +
        "</header>" +
        '<div class="messages" role="log"></div>' +
        '<form class="composer">' +
          '<input class="input" type="text" maxlength="1200" autocomplete="off" placeholder="Type your question..." aria-label="Message">' +
          '<button class="send" type="submit">Send</button>' +
        "</form>" +
        '<form class="lead-form" hidden>' +
          '<p class="lead-title">Want the business team to follow up?</p>' +
          '<input class="lead-input lead-name" type="text" maxlength="120" autocomplete="name" placeholder="Your name" aria-label="Your name">' +
          '<input class="lead-input lead-email" type="email" maxlength="254" autocomplete="email" placeholder="Email address" aria-label="Email address">' +
          '<input class="lead-input lead-phone" type="tel" maxlength="40" autocomplete="tel" placeholder="Phone number" aria-label="Phone number">' +
          '<div class="lead-actions">' +
            '<button class="lead-submit" type="submit">Send contact</button>' +
            '<button class="lead-dismiss" type="button">Not now</button>' +
          "</div>" +
          '<p class="lead-status" role="status"></p>' +
        "</form>" +
      "</section>";

    document.body.appendChild(host);

    var bubble = root.querySelector(".bubble");
    var panel = root.querySelector(".panel");
    var minimize = root.querySelector(".minimize");
    var messages = root.querySelector(".messages");
    var form = root.querySelector(".composer");
    var input = root.querySelector(".input");
    var send = root.querySelector(".send");
    var leadForm = root.querySelector(".lead-form");
    var leadDismiss = root.querySelector(".lead-dismiss");

    if (!history.length) {
      history.push({ role: "bot", text: welcomeMessage, at: Date.now() });
      saveHistory(historyKey, history);
    }

    renderHistory(messages, history);

    bubble.addEventListener("click", function () {
      panel.classList.add("open");
      bubble.classList.add("hidden");
      window.setTimeout(function () { input.focus(); }, 80);
    });

    minimize.addEventListener("click", function () {
      panel.classList.remove("open");
      bubble.classList.remove("hidden");
    });

    form.addEventListener("submit", function (event) {
      event.preventDefault();
      sendMessage({ input: input, send: send, messages: messages, leadForm: leadForm });
    });

    leadForm.addEventListener("submit", function (event) {
      event.preventDefault();
      submitLead({ form: leadForm, messages: messages });
    });

    leadDismiss.addEventListener("click", function () {
      hideLeadForm(leadForm);
    });
  }

  async function sendMessage(ui) {
    var text = clean(ui.input.value, 1200);
    if (!text || ui.send.disabled) return;

    ui.input.value = "";
    lastQuestion = text;
    hideLeadForm(ui.leadForm);
    setDisabled(ui, true);
    addHistoryMessage("user", text, ui.messages);
    var pending = addMessage(ui.messages, "bot", "Typing...", true);

    try {
      var response = await fetch(apiBase + "/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: clientId,
          chatbot_key: chatbotKey,
          message: text,
          session_id: sessionId
        })
      });
      var data = await response.json().catch(function () { return {}; });
      var answer = response.ok && data.answer
        ? clean(data.answer, 4000)
        : clean(data.error, 4000) || "Sorry, support is temporarily unavailable. Please try again in a few minutes.";
      lastChatSessionId = data.chat_session_id || lastChatSessionId;
      pending.textContent = answer || "I don't have that information. Please contact support.";
      history.push({ role: "bot", text: pending.textContent, at: Date.now() });
      saveHistory(historyKey, history);
      if (response.ok && data.fallback) {
        showLeadForm(ui.leadForm);
      }
    } catch (_error) {
      pending.textContent = "Sorry, support is temporarily unavailable. Please try again in a few minutes.";
      history.push({ role: "bot", text: pending.textContent, at: Date.now() });
      saveHistory(historyKey, history);
    } finally {
      setDisabled(ui, false);
      ui.input.focus();
    }
  }

  async function submitLead(ui) {
    var name = clean(ui.form.querySelector(".lead-name").value, 120);
    var email = clean(ui.form.querySelector(".lead-email").value, 254);
    var phone = clean(ui.form.querySelector(".lead-phone").value, 40);
    var status = ui.form.querySelector(".lead-status");
    var submit = ui.form.querySelector(".lead-submit");

    if (!email && !phone) {
      status.textContent = "Please share email or phone.";
      return;
    }

    submit.disabled = true;
    status.textContent = "Sending...";

    try {
      var response = await fetch(apiBase + "/api/chat/lead", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: clientId,
          chatbot_key: chatbotKey,
          session_id: sessionId,
          chat_session_id: lastChatSessionId,
          name: name,
          email: email,
          phone: phone,
          question: lastQuestion,
          source_url: window.location.href
        })
      });
      var data = await response.json().catch(function () { return {}; });
      if (!response.ok) {
        status.textContent = clean(data.error, 220) || "Could not save contact details.";
        return;
      }
      hideLeadForm(ui.form);
      addHistoryMessage("bot", clean(data.message, 220) || "Thanks. The business team has received your contact details.", ui.messages);
    } catch (_error) {
      status.textContent = "Could not send contact details. Please try again.";
    } finally {
      submit.disabled = false;
    }
  }

  function showLeadForm(form) {
    if (!form) return;
    form.hidden = false;
  }

  function hideLeadForm(form) {
    if (!form) return;
    form.hidden = true;
    var status = form.querySelector(".lead-status");
    if (status) status.textContent = "";
  }

  function addHistoryMessage(role, text, messages) {
    history.push({ role: role, text: text, at: Date.now() });
    saveHistory(historyKey, history);
    return addMessage(messages, role, text);
  }

  function renderHistory(messages, items) {
    messages.innerHTML = "";
    items.slice(-30).forEach(function (item) {
      addMessage(messages, item.role, item.text);
    });
  }

  function addMessage(messages, role, text, isPending) {
    var item = document.createElement("div");
    item.className = "msg " + (role === "user" ? "user" : "bot") + (isPending ? " pending" : "");
    item.textContent = text;
    messages.appendChild(item);
    messages.scrollTop = messages.scrollHeight;
    return item;
  }

  function setDisabled(ui, disabled) {
    ui.input.disabled = disabled;
    ui.send.disabled = disabled;
  }

  function getOrCreateSession(key) {
    try {
      var existing = window.localStorage.getItem(key);
      if (existing) return existing;
      var next = window.crypto && crypto.randomUUID
        ? crypto.randomUUID()
        : String(Date.now()) + "-" + Math.random().toString(16).slice(2);
      window.localStorage.setItem(key, next);
      return next;
    } catch (_error) {
      return String(Date.now()) + "-" + Math.random().toString(16).slice(2);
    }
  }

  function loadHistory(key) {
    try {
      var parsed = JSON.parse(window.localStorage.getItem(key) || "[]");
      return Array.isArray(parsed) ? parsed.slice(-30) : [];
    } catch (_error) {
      return [];
    }
  }

  function saveHistory(key, items) {
    try {
      window.localStorage.setItem(key, JSON.stringify(items.slice(-30)));
    } catch (_error) {}
  }

  function clean(value, maxLength) {
    return String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLength);
  }

  function normalizeColor(value) {
    var color = clean(value, 24);
    return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(color) ? color : "";
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, function (char) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[char];
    });
  }

  function escapeAttr(value) {
    return escapeHtml(value).replace(/`/g, "&#096;");
  }

  function styles(side, color) {
    var opposite = side === "left" ? "right" : "left";
    return [
      ":host{all:initial;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#111827}",
      "*{box-sizing:border-box}",
      ".bubble{width:60px;height:60px;border:0;border-radius:999px;background:" + color + ";color:#fff;box-shadow:0 18px 42px rgba(15,23,42,.28);cursor:pointer;display:grid;place-items:center;transition:transform .18s ease,opacity .18s ease}",
      ".bubble:hover{transform:translateY(-2px)}",
      ".bubble.hidden{display:none}",
      ".bubble-icon{width:28px;height:28px;border:2px solid rgba(255,255,255,.9);border-radius:999px;display:grid;place-items:center;font:800 18px/1 Arial,sans-serif}",
      ".panel{display:none;width:min(380px,calc(100vw - 28px));height:min(560px,calc(100vh - 96px));background:#fff;border:1px solid #e5e7eb;border-radius:16px;box-shadow:0 24px 70px rgba(15,23,42,.25);overflow:hidden;transform-origin:bottom " + side + "}",
      ".panel.open{display:flex;flex-direction:column;animation:caic-pop .18s ease-out}",
      "@keyframes caic-pop{from{opacity:0;transform:translateY(8px) scale(.98)}to{opacity:1;transform:translateY(0) scale(1)}}",
      ".header{display:flex;align-items:center;justify-content:space-between;gap:12px;background:" + color + ";color:#fff;padding:15px 16px}",
      ".header strong{display:block;font:800 15px/1.2 inherit;max-width:250px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".header span{display:block;margin-top:3px;font:500 12px/1.2 inherit;opacity:.82}",
      ".minimize{width:32px;height:32px;border:0;border-radius:999px;background:rgba(255,255,255,.16);color:#fff;cursor:pointer;font:700 18px/1 Arial,sans-serif}",
      ".messages{flex:1;overflow:auto;padding:16px;background:#f8fafc;scroll-behavior:smooth}",
      ".msg{max-width:84%;margin:0 0 10px;padding:10px 12px;border-radius:14px;font:500 14px/1.45 inherit;white-space:pre-wrap;overflow-wrap:anywhere}",
      ".msg.bot{background:#fff;border:1px solid #e5e7eb;color:#111827;border-bottom-left-radius:5px}",
      ".msg.user{margin-left:auto;background:" + color + ";color:#fff;border-bottom-right-radius:5px}",
      ".msg.pending{color:#64748b}",
      ".composer{display:flex;gap:8px;padding:12px;border-top:1px solid #e5e7eb;background:#fff}",
      ".input{flex:1;min-width:0;height:42px;border:1px solid #d1d5db;border-radius:12px;padding:0 12px;background:#fff;color:#111827;font:500 14px/1 inherit;outline:none}",
      ".input:focus{border-color:" + color + ";box-shadow:0 0 0 3px rgba(37,99,235,.14)}",
      ".send{height:42px;border:0;border-radius:12px;background:" + color + ";color:#fff;padding:0 14px;font:800 14px/1 inherit;cursor:pointer}",
      ".lead-form{border-top:1px solid #e5e7eb;background:#fff;padding:12px;display:grid;gap:8px}",
      ".lead-form[hidden]{display:none}",
      ".lead-title{margin:0;color:#334155;font:800 13px/1.35 inherit}",
      ".lead-input{width:100%;height:38px;border:1px solid #d1d5db;border-radius:10px;padding:0 10px;background:#fff;color:#111827;font:500 13px/1 inherit;outline:none}",
      ".lead-input:focus{border-color:" + color + ";box-shadow:0 0 0 3px rgba(37,99,235,.12)}",
      ".lead-actions{display:flex;gap:8px;align-items:center}",
      ".lead-submit{height:38px;border:0;border-radius:10px;background:" + color + ";color:#fff;padding:0 12px;font:800 13px/1 inherit;cursor:pointer}",
      ".lead-dismiss{height:38px;border:1px solid #d1d5db;border-radius:10px;background:#fff;color:#334155;padding:0 12px;font:800 13px/1 inherit;cursor:pointer}",
      ".lead-status{min-height:16px;margin:0;color:#64748b;font:700 12px/1.35 inherit}",
      ".send:disabled,.input:disabled,.lead-submit:disabled{opacity:.62;cursor:not-allowed}",
      "@media(max-width:480px){:host{position:fixed;inset:auto 10px 10px auto}.panel{width:calc(100vw - 20px);height:min(620px,calc(100vh - 76px));border-radius:14px}.header strong{max-width:calc(100vw - 120px)}}",
      "@media(max-width:480px){:host-context(body){} .panel{margin-" + opposite + ":0}}"
    ].join("");
  }

  if (document.body) {
    start();
  } else {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  }
}());
