import type { Response } from "express";
import { z } from "zod";
import { ApiError } from "./errors.js";

export const userClaimsSchema = z.object({
  sub: z.string().min(1).max(200).refine((value) => value.trim().length > 0),
  roles: z.array(z.string().min(1).max(100)).max(100).default([]),
  scope: z.string().max(4000).default(""),
});

export type UserContext = Readonly<{
  userId: string;
  roles: readonly string[];
  scopes: readonly string[];
}>;

declare global {
  namespace Express {
    interface Locals {
      user?: UserContext;
      requestId: string;
    }
  }
}

export function getUser(res: Response): UserContext {
  if (!res.locals.user) throw new ApiError(401, "UNAUTHORIZED", "Authentication is required.");
  return res.locals.user;
}
