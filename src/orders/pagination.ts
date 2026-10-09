import { createHash } from "node:crypto";
import { z } from "zod";
import { ApiError } from "../errors.js";
import { uuidSchema } from "./contracts.js";

export const listOrdersSchema = z.object({
  limit: z.string().regex(/^\d+$/).default("20").transform(Number).pipe(z.number().int().min(1).max(100)),
  status: z.enum(["created", "cancelled"]).optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  cursor: z.string().max(2048).optional(),
}).strict().refine((value) => !value.from || !value.to || Date.parse(value.from) <= Date.parse(value.to));
export type ListOrdersInput = z.infer<typeof listOrdersSchema>;

const cursorSchema = z.object({
  v: z.literal(1), userId: z.string().min(1).max(200), filters: z.string().length(64),
  createdAt: z.iso.datetime({ precision: 6 }), id: uuidSchema,
}).strict();
type Cursor = z.infer<typeof cursorSchema>;

function filtersHash(input: ListOrdersInput): string {
  return createHash("sha256").update(JSON.stringify([input.status ?? null, input.from ?? null, input.to ?? null])).digest("hex");
}

export function encodeCursor(userId: string, input: ListOrdersInput, last: { id: string; createdAt: string }): string {
  return Buffer.from(JSON.stringify({ v: 1, userId, filters: filtersHash(input), createdAt: last.createdAt, id: last.id })).toString("base64url");
}

export function decodeCursor(userId: string, input: ListOrdersInput): Cursor | undefined {
  if (input.cursor === undefined) return undefined;
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(input.cursor)) throw new Error("Invalid encoding");
    const buffer = Buffer.from(input.cursor, "base64url");
    if (buffer.toString("base64url") !== input.cursor) throw new Error("Noncanonical cursor");
    const cursor = cursorSchema.parse(JSON.parse(buffer.toString("utf8")));
    if (cursor.userId !== userId || cursor.filters !== filtersHash(input)) throw new Error("Cursor context mismatch");
    return cursor;
  } catch {
    throw new ApiError(400, "INVALID_CURSOR", "Cursor is invalid or does not match the user and filters.");
  }
}
