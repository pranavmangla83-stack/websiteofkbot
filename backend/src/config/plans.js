export const PLAN_LIMITS = {
  basic: {
    websiteCrawling: false,
    maxWebsitePages: 0,
    maxPdfs: 3,
    maxPdfSizeMb: 7,
    monthlyReplies: 400,
    price: 350
  },
  pro: {
    websiteCrawling: true,
    maxWebsitePages: 30,
    maxPdfs: 5,
    maxPdfSizeMb: 10,
    monthlyReplies: 700,
    price: 500
  }
};

export function planKeyForName(planName) {
  const normalized = String(planName || "").trim().toLowerCase();
  if (normalized.includes("pro")) return "pro";
  return "basic";
}
