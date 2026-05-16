import { env } from "../config/env.js";

export async function notifyLeadSubmitted({ client, lead }) {
  if (!env.resendApiKey || !env.supportEmail) {
    return { sent: false, skipped: true };
  }

  const subject = `New chatbot lead${client?.company_name ? ` for ${client.company_name}` : ""}`;
  const text = [
    "A visitor submitted contact details through the website chatbot.",
    "",
    `Client: ${client?.email || "Unknown"}`,
    `Company: ${client?.company_name || "Unknown"}`,
    `Name: ${lead.name || "Not provided"}`,
    `Email: ${lead.email || "Not provided"}`,
    `Phone: ${lead.phone || "Not provided"}`,
    `Question: ${lead.question || "Not provided"}`,
    `Source URL: ${lead.sourceUrl || "Not provided"}`
  ].join("\n");

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.resendApiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: env.notificationFromEmail,
      to: [env.supportEmail],
      subject,
      text
    })
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`Lead notification email failed with ${response.status}: ${errorText}`);
  }

  return { sent: true };
}
