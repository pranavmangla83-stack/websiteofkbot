const blockedPathPatterns = [
  /^\/wp-admin(?:\/|$)/i,
  /^\/wp-login\.php$/i,
  /^\/wp-content(?:\/|$)/i,
  /^\/wp-includes(?:\/|$)/i,
  /^\/xmlrpc\.php$/i,
  /^\/wordpress(?:\/|$)/i,
  /^\/phpmyadmin(?:\/|$)/i,
  /^\/pma(?:\/|$)/i,
  /^\/adminer(?:\/|$)/i,
  /^\/\.env(?:\.|$)/i,
  /^\/\.git(?:\/|$)/i,
  /^\/vendor(?:\/|$)/i,
  /^\/composer\.(?:json|lock)$/i
];

const blockedUserAgentPattern = /\b(?:aiohttp|python-requests|python\/|curl|wget|nikto|sqlmap|masscan|zgrab)\b|headlesschrome/i;
const allowedGoogleCrawlerPattern = /\b(?:AdsBot-Google|Googlebot|Google-InspectionTool|Mediapartners-Google|APIs-Google)\b/i;

export function blockScannerTraffic(req, res, next) {
  const pathname = req.path || "/";
  const userAgent = req.get("user-agent") || "";

  if (blockedPathPatterns.some((pattern) => pattern.test(pathname))) {
    return res.status(403).type("text/plain").send("Forbidden");
  }

  if (allowedGoogleCrawlerPattern.test(userAgent)) {
    return next();
  }

  if (blockedUserAgentPattern.test(userAgent)) {
    return res.status(403).type("text/plain").send("Forbidden");
  }

  next();
}
