import type { RequestHandler } from "express";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Config } from "./config.js";
import { ApiError } from "./errors.js";
import { userClaimsSchema } from "./user.js";

export function createAuthenticate(config: Config): RequestHandler {
  // The deployment chooses exactly one algorithm; token headers cannot select another verifier.
  const key = config.JWT_MODE === "RS256"
    ? createRemoteJWKSet(new URL(config.JWT_JWKS_URL!), {
      timeoutDuration: config.JWKS_TIMEOUT_MS,
      cooldownDuration: config.JWKS_COOLDOWN_MS,
      cacheMaxAge: config.JWKS_CACHE_MAX_AGE_MS,
    })
    : new TextEncoder().encode(config.JWT_SECRET);
  return async (req, res, next) => {
    const match = /^Bearer ([^\s]+)$/i.exec(req.get("Authorization") ?? "");
    if (!match?.[1]) {
      throw new ApiError(401, "UNAUTHORIZED", "A valid bearer token is required.");
    }
    try {
      const { payload } = await jwtVerify(match[1], key, {
        algorithms: [config.JWT_MODE],
        issuer: config.JWT_ISSUER,
        audience: config.JWT_AUDIENCE,
        requiredClaims: ["sub", "exp", "iat"],
      });
      // Extract an allowlist of claims only after signature and registered-claim verification.
      const claims = userClaimsSchema.parse(payload);
      res.locals.user = Object.freeze({
        userId: claims.sub,
        roles: Object.freeze([...new Set(claims.roles)]),
        scopes: Object.freeze([...new Set(claims.scope.split(/\s+/).filter(Boolean))]),
      });
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      if (config.JWT_MODE === "RS256" && (error instanceof TypeError || code === "ERR_JWKS_TIMEOUT" || code === "ERR_JOSE_GENERIC")) {
        throw new ApiError(503, "AUTH_UNAVAILABLE", "Token verification is temporarily unavailable.");
      }
      throw new ApiError(401, "UNAUTHORIZED", "A valid bearer token is required.");
    }
    next();
  };
}
