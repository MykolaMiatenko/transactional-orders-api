import type { RequestHandler } from "express";
import { jwtVerify } from "jose";
import type { Config } from "./config.js";
import { ApiError } from "./errors.js";
import { userClaimsSchema } from "./user.js";

export function createAuthenticate(config: Pick<Config, "JWT_SECRET" | "JWT_ISSUER" | "JWT_AUDIENCE">): RequestHandler {
  const key = new TextEncoder().encode(config.JWT_SECRET);
  return async (req, res, next) => {
    const match = /^Bearer ([^\s]+)$/i.exec(req.get("Authorization") ?? "");
    if (!match?.[1]) {
      throw new ApiError(401, "UNAUTHORIZED", "A valid bearer token is required.");
    }
    try {
      const { payload } = await jwtVerify(match[1], key, {
        algorithms: ["HS256"],
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
    } catch {
      throw new ApiError(401, "UNAUTHORIZED", "A valid bearer token is required.");
    }
    next();
  };
}
