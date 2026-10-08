import type { RequestHandler } from "express";
import { jwtVerify } from "jose";
import type { Config } from "./config.js";
import { ApiError } from "./errors.js";

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
      if (!payload.sub?.trim() || payload.sub.length > 200) {
        throw new Error("Invalid token subject");
      }
      res.locals.userId = payload.sub;
    } catch {
      throw new ApiError(401, "UNAUTHORIZED", "A valid bearer token is required.");
    }
    next();
  };
}
