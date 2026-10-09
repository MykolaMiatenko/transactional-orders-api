import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import SwaggerParser from "@apidevtools/swagger-parser";
import type { Pool } from "pg";
import { pino } from "pino";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

test("OpenAPI is valid and Swagger UI is available locally but disabled in production", async () => {
  await SwaggerParser.validate(fileURLToPath(new URL("../docs/openapi.json", import.meta.url)));
  const config = loadConfig({ NODE_ENV: "test", DATABASE_URL: "postgres://unused/test", JWT_SECRET: "x".repeat(32) });
  for (const production of [false, true]) {
    const app = createApp({} as Pool, { ...config, NODE_ENV: production ? "production" : "test" }, pino({ level: "silent" }));
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      assert.equal((await fetch(`${base}/openapi.json`)).status, production ? 404 : 200);
      const docs = await fetch(`${base}/docs/`);
      assert.equal(docs.status, production ? 404 : 200);
      if (!production) {
        assert.match(await docs.text(), /swagger-ui/);
        assert.equal((await fetch(`${base}/docs/swagger-ui-init.js`)).status, 200);
      }
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  }
});
