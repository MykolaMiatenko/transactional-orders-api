# Transactional Order API

This project demonstrates a Node.js order API with transactional persistence, atomic inventory reservations, and idempotent request handling. It includes verified JWT authentication, a typed user context, ownership checks, runtime validation, and integration tests against real PostgreSQL.

Stack: Node.js, TypeScript, Express 5, PostgreSQL with `pg`, Zod for validation, `jose` for JWT verification, and Pino for structured logging.

## Getting started

Requirements: Node.js 22+ and Docker with Compose. Run these commands from the project directory:

```bash
npm ci
cp .env.example .env
docker compose up -d --wait db
npm run db:migrate
npm run db:seed
npm run dev
```

The server listens on `http://localhost:3000`. The seed creates product `7106f556-b21c-4a1f-b155-44327735deae` with a price of 1999 cents and an initial stock of 100. Running the seed again does not replenish inventory consumed by existing orders.

In another terminal, generate a local token and create an order:

```bash
TOKEN=$(npm run --silent token:dev -- demo-user)
KEY=$(node -e 'console.log(require("node:crypto").randomUUID())')

curl -i http://localhost:3000/api/orders \
  -H "Authorization: Bearer $TOKEN" \
  -H "Idempotency-Key: $KEY" \
  -H "Content-Type: application/json" \
  -d '{"productId":"7106f556-b21c-4a1f-b155-44327735deae","quantity":2}'
```

Expect `201 Created`, a `Location: /api/orders/<id>` header, and this JSON response:

```json
{
  "id": "<generated UUID>",
  "productId": "7106f556-b21c-4a1f-b155-44327735deae",
  "quantity": 2,
  "totalCents": 3998
}
```

Repeat the same `curl` with the same `$KEY`: the API returns the same JSON and status 201 without consuming stock again. Generate a new key for each new order. Reusing a key with a different payload returns 409.

## HTTP contract

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/me` | Read the current user's verified identity, roles, and scopes |
| POST | `/api/orders` | Create an order; requires Bearer JWT and a UUID `Idempotency-Key` |
| GET | `/api/orders/:id` | Read an owned order; requires Bearer JWT |
| GET | `/health/live` | Check HTTP server liveness |
| GET | `/health/ready` | Check database connectivity |

The creation body accepts only `productId` (UUID) and `quantity` (an integer from 1 to 100). The price comes from the database; the user ID comes from the verified JWT. UUIDs are normalized to lowercase. Monetary values are stored as integer cents.

Errors use this format:

```json
{
  "code": "INSUFFICIENT_STOCK",
  "message": "Not enough items in stock.",
  "requestId": "<request UUID>"
}
```

`X-Request-Id` matches the ID in request logs. Each HTTP request receives a new request ID, including retries.

| Status | Code | Reason |
|---|---|---|
| 400 | `INVALID_REQUEST` | Invalid body, UUID, query parameters, or missing key |
| 400 | `INVALID_JSON` | Malformed JSON |
| 401 | `UNAUTHORIZED` | Missing, invalid, or expired token |
| 404 | `PRODUCT_NOT_FOUND` | Product does not exist |
| 404 | `ORDER_NOT_FOUND` | Order does not exist or belongs to another user |
| 404 | `NOT_FOUND` | Unknown route |
| 409 | `INSUFFICIENT_STOCK` | Not enough inventory |
| 409 | `IDEMPOTENCY_KEY_REUSED` | Key was already used with a different payload |
| 413 | `PAYLOAD_TOO_LARGE` | JSON body exceeds 16 KB |
| 415 | `UNSUPPORTED_ENCODING` | Unsupported body encoding |
| 503 | `DATABASE_BUSY` | Lock timeout, SQL timeout, or transaction conflict |
| 503 | `DATABASE_UNAVAILABLE` | Recognized database connection failure |
| 503 | `NOT_READY` | Database is unavailable for the readiness probe |
| 500 | `INTERNAL_ERROR` | Unexpected failure; internal details are not exposed |

For 503 responses, the API sets `Retry-After: 1`. After a timeout, network failure, or uncertain creation outcome, retry with **the same key and payload**: the transaction may already have committed.

## Transactions and concurrency

`OrderService.create()` executes every SQL statement through one `pg` client in a `READ COMMITTED` transaction:

1. Claim `(user_id, operation, request_key)` using a database uniqueness constraint.
2. For an existing key, verify the SHA-256 hash of the normalized payload and return the stored response.
3. Execute `UPDATE products ... WHERE stock >= quantity` to check and reserve inventory atomically.
4. Store the order and JSON response, then commit.

PostgreSQL coordinates concurrent retries across API processes. `READ COMMITTED` allows the subsequent SELECT to observe the competing transaction's committed result after waiting on the unique key. Any failure before commit rolls back the order, inventory change, and idempotency record together. Failed business requests are not cached. The client is released exactly once in `finally`; a connection that cannot roll back is discarded from the pool.

Successful idempotency keys have no automatic TTL. Define a business retry window before deleting them: a replay after deletion can create another order.

SQL timeout is 5 seconds, lock timeout is 2 seconds, and connection acquisition timeout is 3 seconds. On SIGINT/SIGTERM, the server stops accepting new requests, drains active handlers, and closes the pool. The shutdown deadline is 10 seconds.

## Authentication and configuration

The `jose` library verifies the HS256 signature, issuer, audience, required `sub`/`iat`/`exp` claims, expiration, and `nbf` when present. The `sub` claim identifies the user. JWTs are verified before claims are used for identity or ownership checks; decoding a token alone does not authenticate a caller.

Middleware builds an immutable, typed `UserContext` from `sub`, `roles` (an array of strings), and `scope` (a space-separated string). Duplicate roles and scopes are removed; missing optional claims default to empty arrays. Malformed claim types, missing subjects, and empty subjects return 401.

`GET /api/me` returns only the allowlisted `userId`, `roles`, and `scopes` fields. It does not return the token or arbitrary claims. For the default development token:

```bash
curl http://localhost:3000/api/me -H "Authorization: Bearer $TOKEN"
```

```json
{
  "userId": "demo-user",
  "roles": [],
  "scopes": []
}
```

The current `main` implementation extracts roles and scopes but does not enforce scope-based authorization. Order access is restricted to the authenticated owner through the verified `sub` claim. There is no user-profile database or HTTP token-issuance endpoint.

`npm run --silent token:dev -- demo-user` generates a local HS256 token valid for one hour. This development helper accepts a user ID and is disabled in production. Before deployment, set a cryptographically random `JWT_SECRET` of at least 32 bytes and align issuer/audience with your token issuer. The server rejects the demonstration secret in production.

| Variable | Purpose | Default |
|---|---|---|
| `DATABASE_URL` | PostgreSQL connection string | Required |
| `JWT_SECRET` | JWT signing secret | Required |
| `JWT_ISSUER` | Expected issuer | `order-api` |
| `JWT_AUDIENCE` | Expected audience | `order-api-clients` |
| `PORT` | HTTP port | `3000` |
| `DB_POOL_MAX` | Maximum API pool connections | `10` |
| `NODE_ENV` | `development`, `test`, or `production` | `development` |
| `LOG_LEVEL` | Pino log level | `info` |
| `TEST_DATABASE_URL` | Dedicated integration test database | Required for `npm test` |

For remote PostgreSQL, enable TLS certificate verification according to your provider's configuration; for example, use `sslmode=verify-full` and a trusted CA in the connection string. Local Compose services are intended for development and expose PostgreSQL only on `127.0.0.1`.

## Verification

```bash
npm run typecheck
npm run build

docker compose exec -T db createdb -U orders orders_test
TEST_DATABASE_URL=postgres://orders:orders@localhost:5432/orders_test npm test
```

Create `orders_test` only once. Tests use real PostgreSQL, create a random isolated schema, and remove it afterward. `DATABASE_URL` is never a fallback for tests. Coverage includes creation, reads, ownership isolation, parallel retries, concurrent stock reservations, payload conflicts, rollback, retry after insufficient stock, lock timeouts, UUID normalization, verified JWT claims, the current-user endpoint, and HTTP errors.

GitHub Actions runs type checks, the build, and the same integration tests with PostgreSQL 17. The current suite contains 16 tests.

Run the compiled server:

```bash
npm run build
npm start
```

Run migrations separately before starting the API. They are serialized by an advisory lock, applied transactionally, and verify checksums of previously applied files. Add a new SQL file in `db/migrations` for schema changes instead of editing applied migrations.

## Project structure

```text
src/
  app.ts                 # HTTP composition, current-user endpoint, and errors
  server.ts              # Startup and graceful shutdown
  auth.ts                # HS256 JWT verification
  user.ts                # Typed identity extracted from verified claims
  config.ts              # Environment validation
  database.ts            # Connection pool
  errors.ts              # API errors
  migrate.ts             # Transactional migration runner
  orders/
    contracts.ts         # Runtime validation and response types
    router.ts            # HTTP routes
    service.ts           # Transactional business logic
db/migrations/           # Versioned SQL schema
scripts/                 # Migrations, demo seed, and local JWT generation
test/api.test.ts         # PostgreSQL integration and concurrency tests
compose.yaml             # Local PostgreSQL
```

## Implementation status

This README describes the implementation currently present in `main`: order creation and reads, idempotency, inventory reservations, JWT verification, and `/api/me`.

Scope authorization, RS256/JWKS, cursor pagination, cancellation, RabbitMQ outbox, and OpenAPI have been implemented in the [full feature branch](https://github.com/MykolaMiatenko/transactional-orders-api/tree/feat/06-outbox-and-openapi). Those changes have not yet been integrated into `main`. Consult that branch's README for its additional services, endpoints, and commands.

Each order contains one product. Payments, a shopping cart, and a catalog are outside this example's scope.
