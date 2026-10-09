import type { RequestHandler } from "express";
import { ApiError } from "./errors.js";
import { getUser } from "./user.js";

export function requireScopes(...required: string[]): RequestHandler {
  return (_req, res, next) => {
    const user = getUser(res);
    if (!required.every((scope) => user.scopes.includes(scope))) {
      throw new ApiError(403, "FORBIDDEN", "The token does not grant the required scopes.");
    }
    next();
  };
}
