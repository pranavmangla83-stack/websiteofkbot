import { createRemoteJWKSet, decodeJwt, jwtVerify } from "jose";
import { env, requireEnv } from "../config/env.js";

let jwks;
let issuer;

function getKindeVerifier() {
  requireEnv(["kindeIssuerUrl"]);

  if (!jwks) {
    issuer = env.kindeIssuerUrl.replace(/\/$/, "");
    jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
  }

  return { issuer, jwks };
}

export async function requireAuth(req, res, next) {
  try {
    const authHeader = req.get("authorization") || "";
    const [scheme, token] = authHeader.split(" ");

    if (scheme !== "Bearer" || !token) {
      return res.status(401).json({ error: "Missing bearer token" });
    }

    const verifier = getKindeVerifier();
    const verifyOptions = {
      issuer: verifier.issuer
    };
    const unverifiedPayload = decodeJwt(token);

    const allowedAudiences = [env.kindeAudience, env.kindeClientId].filter(Boolean);
    if (allowedAudiences.length) {
      if (!tokenHasAllowedAudience(unverifiedPayload.aud, allowedAudiences)) {
        return res.status(401).json({ error: "Login token is not valid for this API" });
      }
      verifyOptions.audience = allowedAudiences;
    }

    const { payload } = await jwtVerify(token, verifier.jwks, verifyOptions);

    if (!payload.sub) {
      return res.status(401).json({ error: "Invalid token subject" });
    }

    req.auth = {
      kindeUserId: payload.sub,
      email: payload.email || null,
      name: payload.name || [payload.given_name, payload.family_name].filter(Boolean).join(" ") || null,
      claims: payload
    };

    next();
  } catch (error) {
    console.error("Kinde token verification failed:", error.code || error.name || "auth_error", error.message);
    next(Object.assign(error, {
      statusCode: 401,
      publicMessage: `Invalid or expired login token: ${error.code || error.name || "auth_error"}`
    }));
  }
}

function tokenHasAllowedAudience(tokenAudience, allowedAudiences) {
  if (Array.isArray(tokenAudience)) {
    return allowedAudiences.some((audience) => tokenAudience.includes(audience));
  }

  return allowedAudiences.includes(tokenAudience);
}
