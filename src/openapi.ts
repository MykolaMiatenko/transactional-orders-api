import { existsSync, readFileSync } from "node:fs";
import type { Express } from "express";
import helmet from "helmet";
import swaggerUi from "swagger-ui-express";

const source = new URL("../docs/openapi.json", import.meta.url);
const file = existsSync(source) ? source : new URL("../../docs/openapi.json", import.meta.url);
export const openApiDocument = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;

export function mountDocumentation(app: Express): void {
  app.get("/openapi.json", (_req, res) => res.json(openApiDocument));
  app.use("/docs", helmet({ contentSecurityPolicy: { directives: {
    "upgrade-insecure-requests": null, "script-src": ["'self'"], "style-src": ["'self'", "'unsafe-inline'"],
  } } }), swaggerUi.serve, swaggerUi.setup(openApiDocument, { swaggerOptions: { persistAuthorization: false } }));
}
