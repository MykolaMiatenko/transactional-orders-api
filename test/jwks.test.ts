import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import express, { type ErrorRequestHandler } from "express";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from "jose";
import { createAuthenticate } from "../src/auth.js";
import { loadConfig } from "../src/config.js";
import { ApiError } from "../src/errors.js";
import { getUser } from "../src/user.js";

test("RS256 verifies claims, caches JWKS, rotates keys and rejects invalid tokens", async () => {
  const first = await generateKeyPair("RS256");
  const second = await generateKeyPair("RS256");
  let keys: JWK[] = [{ ...await exportJWK(first.publicKey), kid: "first", alg: "RS256", use: "sig" }];
  let hits = 0;
  let unavailable = false;
  const jwks = createServer((_req, res) => {
    hits++;
    if (unavailable) { res.writeHead(503).end(); return; }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ keys }));
  }).listen(0, "127.0.0.1");
  await once(jwks, "listening");
  const config = loadConfig({ NODE_ENV: "test", DATABASE_URL: "postgres://unused/test", JWT_MODE: "RS256",
    JWT_JWKS_URL: `http://127.0.0.1:${(jwks.address() as AddressInfo).port}/jwks`,
    JWT_ISSUER: "trusted", JWT_AUDIENCE: "orders", JWKS_COOLDOWN_MS: "0" });
  const app = express();
  app.get("/", createAuthenticate(config), (_req, res) => res.json(getUser(res)));
  const errors: ErrorRequestHandler = (error: unknown, _req, res, _next) => res.status(error instanceof ApiError ? error.status : 500).end();
  app.use(errors);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const sign = (key: CryptoKey, kid: string, issuer = "trusted", audience = "orders", expiry = "1m") =>
    new SignJWT({ scope: "orders:read" }).setProtectedHeader({ alg: "RS256", kid })
      .setSubject("user").setIssuer(issuer).setAudience(audience).setIssuedAt().setExpirationTime(expiry).sign(key);
  const request = (token: string) => fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  try {
    const token = await sign(first.privateKey, "first");
    assert.equal((await request(token)).status, 200);
    assert.equal((await request(token)).status, 200);
    assert.equal(hits, 1);
    for (const invalid of [await sign(first.privateKey, "first", "wrong"), await sign(first.privateKey, "first", "trusted", "wrong"),
      await sign(first.privateKey, "first", "trusted", "orders", "-1s"), await sign(second.privateKey, "first")]) {
      assert.equal((await request(invalid)).status, 401);
    }
    const hs = await new SignJWT({}).setProtectedHeader({ alg: "HS256" }).sign(new TextEncoder().encode("x".repeat(32)));
    assert.equal((await request(hs)).status, 401);
    keys = [{ ...await exportJWK(second.publicKey), kid: "second", alg: "RS256", use: "sig" }];
    assert.equal((await request(await sign(second.privateKey, "second"))).status, 200);
    assert.equal(hits, 2);
    assert.equal((await request(await sign(second.privateKey, "unknown"))).status, 401);
    unavailable = true;
    assert.equal((await request(await sign(first.privateKey, "unavailable"))).status, 503);
  } finally {
    await Promise.all([new Promise<void>((resolve) => server.close(() => resolve())), new Promise<void>((resolve) => jwks.close(() => resolve()))]);
  }
});

test("JWKS timeout fails closed and production rejects insecure configuration", async () => {
  const key = await generateKeyPair("RS256");
  const jwks = createServer((_req, _res) => {}).listen(0, "127.0.0.1");
  await once(jwks, "listening");
  const config = loadConfig({ NODE_ENV: "test", DATABASE_URL: "postgres://unused/test", JWT_MODE: "RS256", JWKS_TIMEOUT_MS: "100",
    JWT_JWKS_URL: `http://127.0.0.1:${(jwks.address() as AddressInfo).port}`, JWT_ISSUER: "trusted", JWT_AUDIENCE: "orders" });
  const app = express();
  app.get("/", createAuthenticate(config), (_req, res) => res.end());
  const handler: ErrorRequestHandler = (error: unknown, _req, res, _next) => res.status(error instanceof ApiError ? error.status : 500).end();
  app.use(handler);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const token = await new SignJWT({}).setProtectedHeader({ alg: "RS256", kid: "test" }).setIssuer("trusted")
      .setAudience("orders").setSubject("user").setIssuedAt().setExpirationTime("1m").sign(key.privateKey);
    assert.equal((await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, { headers: { Authorization: `Bearer ${token}` } })).status, 503);
    assert.throws(() => loadConfig({ NODE_ENV: "production", DATABASE_URL: "postgres://unused/test", JWT_MODE: "RS256", JWT_JWKS_URL: "http://untrusted/jwks" }));
    assert.throws(() => loadConfig({ NODE_ENV: "test", DATABASE_URL: "postgres://unused/test", JWT_MODE: "RS256" }));
  } finally {
    jwks.closeAllConnections();
    await Promise.all([new Promise<void>((resolve) => server.close(() => resolve())), new Promise<void>((resolve) => jwks.close(() => resolve()))]);
  }
});
