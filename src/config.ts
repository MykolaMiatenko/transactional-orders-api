import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.url().refine((url) => /^(postgres|postgresql):/.test(url)),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  JWT_MODE: z.enum(["HS256", "RS256"]).default("HS256"),
  JWT_SECRET: z.string().optional(),
  JWT_JWKS_URL: z.url().optional(),
  JWKS_TIMEOUT_MS: z.coerce.number().int().min(100).max(10_000).default(3000),
  JWKS_COOLDOWN_MS: z.coerce.number().int().min(0).max(300_000).default(30_000),
  JWKS_CACHE_MAX_AGE_MS: z.coerce.number().int().min(1000).max(3_600_000).default(600_000),
  JWT_ISSUER: z.string().min(1).default("order-api"),
  JWT_AUDIENCE: z.string().min(1).default("order-api-clients"),
  AMQP_URL: z.url().refine((value) => /^(amqp|amqps):/.test(value)).default("amqp://orders:orders@localhost:5672"),
  OUTBOX_POLL_MS: z.coerce.number().int().min(100).max(60_000).default(1000),
  OUTBOX_LEASE_MS: z.coerce.number().int().min(1000).max(300_000).default(30_000),
  OUTBOX_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
  OUTBOX_BACKOFF_MS: z.coerce.number().int().min(100).max(60_000).default(1000),
  AMQP_CONFIRM_TIMEOUT_MS: z.coerce.number().int().min(100).max(10_000).default(5000),
  CONSUMER_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
}).superRefine((config, ctx) => {
  if (config.OUTBOX_LEASE_MS <= config.AMQP_CONFIRM_TIMEOUT_MS + 5000) {
    ctx.addIssue({ code: "custom", path: ["OUTBOX_LEASE_MS"], message: "Lease must exceed confirm timeout plus database timeout." });
  }
  if (config.JWT_MODE === "HS256" && Buffer.byteLength(config.JWT_SECRET ?? "") < 32) {
    ctx.addIssue({ code: "custom", path: ["JWT_SECRET"], message: "HS256 requires at least 32 bytes." });
  }
  if (config.JWT_MODE === "RS256" && !config.JWT_JWKS_URL) {
    ctx.addIssue({ code: "custom", path: ["JWT_JWKS_URL"], message: "RS256 requires a JWKS URL." });
  }
  if (config.JWT_JWKS_URL && new URL(config.JWT_JWKS_URL).protocol !== "https:" && config.NODE_ENV !== "test") {
    ctx.addIssue({ code: "custom", path: ["JWT_JWKS_URL"], message: "JWKS must use HTTPS outside tests." });
  }
  if (config.NODE_ENV !== "test" && config.JWKS_COOLDOWN_MS < 1000) {
    ctx.addIssue({ code: "custom", path: ["JWKS_COOLDOWN_MS"], message: "Use a cooldown of at least 1000 ms." });
  }
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    // Report field names only to avoid leaking configuration secrets.
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".")))];
    throw new Error(`Invalid environment configuration: ${fields.join(", ")}`);
  }
  if (parsed.data.NODE_ENV === "production" && parsed.data.JWT_MODE === "HS256" && parsed.data.JWT_SECRET?.startsWith("local-development-")) {
    throw new Error("Replace the development JWT secret before running in production.");
  }
  return parsed.data;
}
