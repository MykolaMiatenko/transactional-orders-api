# Transactional Order API

This project demonstrates an order API with transactional persistence, atomic inventory reservations, and idempotent request handling. It covers concurrent requests and failure recovery, JWT authentication with scopes and JWKS, cursor pagination, transactional cancellation, and event delivery through an outbox. Integration tests verify behavior against real PostgreSQL and RabbitMQ services.

Stack: Node.js, TypeScript, Express 5, PostgreSQL with `pg`, Zod for validation, `jose` for JWT verification, Pino for structured logging, RabbitMQ for messaging, and OpenAPI/Swagger UI for documentation.

## Getting started

Requirements: Node.js 22+ and Docker with Compose. Run these commands from the project directory:

```bash
npm ci
cp .env.example .env
docker compose up -d --wait db rabbitmq
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
| GET | `/api/orders` | List own orders with cursor pagination and filters; requires `orders:read` |
| POST | `/api/orders/:id/cancel` | Cancel an owned order; requires `orders:cancel`, no body |
| PUT | `/api/products/:id/stock` | Replace stock with `{ "stock": 100 }`; requires `inventory:write` |
| POST | `/api/orders` | Create an order; requires Bearer JWT, `orders:create`, and a UUID `Idempotency-Key` |
| GET | `/api/orders/:id` | Read an owned order; requires Bearer JWT and `orders:read` |
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
| 400 | `INVALID_CURSOR` | Cursor does not match the expected format, user, or filters |
| 400 | `INVALID_JSON` | Malformed JSON |
| 401 | `UNAUTHORIZED` | Missing, invalid, or expired token |
| 403 | `FORBIDDEN` | Token lacks a required scope |
| 404 | `PRODUCT_NOT_FOUND` | Product does not exist |
| 404 | `ORDER_NOT_FOUND` | Order does not exist or belongs to another user |
| 404 | `NOT_FOUND` | Unknown route |
| 409 | `INSUFFICIENT_STOCK` | Not enough inventory |
| 409 | `IDEMPOTENCY_KEY_REUSED` | Key was already used with a different payload |
| 413 | `PAYLOAD_TOO_LARGE` | JSON body exceeds 16 KB |
| 415 | `UNSUPPORTED_ENCODING` | Unsupported body encoding |
| 503 | `AUTH_UNAVAILABLE` | JWKS endpoint is unavailable or timed out |
| 503 | `DATABASE_BUSY` | Lock timeout, SQL timeout, or transaction conflict |
| 503 | `DATABASE_UNAVAILABLE` | Recognized database connection failure |
| 503 | `NOT_READY` | Database is unavailable for the readiness probe |
| 500 | `INTERNAL_ERROR` | Unexpected failure; internal details are not exposed |

For 503 responses, the API sets `Retry-After: 1`. After a timeout, network failure, or uncertain creation outcome, retry with **the same key and payload**: the transaction may already have committed.

## Transactions and concurrency

`GET /api/orders?limit=20&status=created&from=2026-01-01T00:00:00Z` returns `{ "items": [...], "nextCursor": "..." }`. The `limit` range is 1–100, with a default of 20. The `status` filter accepts `created` or `cancelled`; `from` and `to` are inclusive ISO 8601 timestamps with a timezone. Pass `cursor` and the same filters to fetch the next page. Cursors are bound to the user and filters; invalid cursors return 400 `INVALID_CURSOR`. Sorting uses `(created_at DESC, id DESC)` and preserves PostgreSQL microseconds. Pagination does not provide a snapshot: newer records inserted after the first page are excluded from continuation pages, while status changes can affect filtered results.

Order reads also return `status`, `createdAt`, and `cancelledAt`. The creation response stays unchanged for idempotent replays.

`POST /api/orders/:id/cancel` transitions an order from `created` to `cancelled` and returns its current state with `cancelledAt`. Locking the order row, changing its status, and restoring stock happen in one transaction. Repeated cancellation returns 200 and the same state without restoring stock twice. Replaying the original creation request after cancellation returns the original creation response; use GET to read the current state.

`OrderService.create()` executes every SQL statement through one `pg` client in a `READ COMMITTED` transaction:

1. Claim `(user_id, operation, request_key)` using a database uniqueness constraint.
2. For an existing key, verify the SHA-256 hash of the normalized payload and return the stored response.
3. Execute `UPDATE products ... WHERE stock >= quantity` to check and reserve inventory atomically.
4. Store the order, JSON response, and `OrderCreated` outbox event, then commit.

PostgreSQL coordinates concurrent retries across API processes. `READ COMMITTED` allows the subsequent SELECT to observe the competing transaction's committed result after waiting on the unique key. Any failure before commit rolls back the order, inventory change, idempotency record, and event together. Failed business requests are not cached. The client is released exactly once in `finally`; a connection that cannot roll back is discarded from the pool.

Successful idempotency keys have no automatic TTL. Define a business retry window before deleting them: a replay after deletion can create another order.

SQL timeout is 5 seconds, lock timeout is 2 seconds, and connection acquisition timeout is 3 seconds. On SIGINT/SIGTERM, the server stops accepting new requests, drains active handlers, and closes the pool. The shutdown deadline is 10 seconds.

## Authentication and configuration

Authorization checks exact scopes: `orders:create` for creation, `orders:read` for order reads, `orders:cancel` for cancellation, and `inventory:write` for stock replacement. A valid token without a required scope receives 403 `FORBIDDEN`; a missing or invalid token receives 401. Roles do not replace scopes or ownership checks. Stock replacement sets an absolute physical count rather than incrementing it; repeating the same value does not add stock again.

Local token generator: `npm run --silent token:dev -- demo-user "orders:read orders:create orders:cancel" buyer`. Arguments after `--` are the user ID, space-separated scopes, and comma-separated roles. Explicitly request `inventory:write` for an administrative token; the default buyer token does not include it.

After JWT verification, middleware builds a typed `UserContext` from `sub`, `roles` (an array of strings), and `scope` (a space-separated string). `GET /api/me` returns only `userId`, `roles`, and `scopes`; arbitrary claims, personal information, and the token itself are excluded. Malformed claims return 401. Roles alone do not grant access to operations.

The `jose` library verifies the **HS256** or **RS256** signature selected by `JWT_MODE`, issuer, audience, required `sub`/`iat`/`exp` claims, expiration, and `nbf` when present. The `sub` claim identifies the user. The development token generator issues one-hour tokens and is disabled in production. There is no HTTP token-issuance endpoint.

For HS256 deployments, set a cryptographically random `JWT_SECRET` of at least 32 bytes and align issuer/audience with your token issuer. The server rejects the demo secret in production. For an external provider, set `JWT_MODE=RS256`, an HTTPS `JWT_JWKS_URL`, issuer, and audience; `JWT_SECRET` is not required in this mode. `jose` caches JWKS, refreshes keys subject to a cooldown, and bounds HTTP request duration. Unknown key IDs or invalid signatures return 401; an unavailable endpoint or timeout returns 503 `AUTH_UNAVAILABLE`. There is no algorithm fallback, and the key URL comes exclusively from configuration.

| Variable | Purpose | Default |
|---|---|---|
| `DATABASE_URL` | PostgreSQL connection string | Required |
| `JWT_SECRET` | JWT signing secret | Required for HS256 |
| `JWT_MODE` | Allowed verification algorithm | `HS256` |
| `JWT_JWKS_URL` | Trusted JWKS endpoint | Required for RS256 |
| `JWKS_TIMEOUT_MS` | JWKS HTTP timeout | `3000` |
| `JWKS_COOLDOWN_MS` | Minimum interval between key-triggered refreshes | `30000` |
| `JWKS_CACHE_MAX_AGE_MS` | Maximum key cache age | `600000` |
| `JWT_ISSUER` | Expected issuer | `order-api` |
| `JWT_AUDIENCE` | Expected audience | `order-api-clients` |
| `PORT` | HTTP port | `3000` |
| `DB_POOL_MAX` | Maximum API pool connections | `10` |
| `NODE_ENV` | `development`, `test`, or `production` | `development` |
| `LOG_LEVEL` | Pino log level | `info` |
| `AMQP_URL` | RabbitMQ connection string | `amqp://orders:orders@localhost:5672` |
| `OUTBOX_POLL_MS` | Worker pause when no events are ready | `1000` |
| `OUTBOX_LEASE_MS` | Delivery lease duration | `30000` |
| `OUTBOX_MAX_ATTEMPTS` | Maximum publication attempts | `5` |
| `OUTBOX_BACKOFF_MS` | Initial retry delay | `1000` |
| `AMQP_CONFIRM_TIMEOUT_MS` | Publisher confirm timeout | `5000` |
| `CONSUMER_MAX_ATTEMPTS` | Processing attempts before dead-lettering | `5` |
| `TEST_DATABASE_URL` | Dedicated integration test database | Required for `npm test` |
| `TEST_AMQP_URL` | Test RabbitMQ service | Required for `npm test` |

For remote PostgreSQL, enable TLS certificate verification according to your provider's configuration; for example, use `sslmode=verify-full` and a trusted CA in the connection string. Local Compose services are intended for development and expose PostgreSQL and RabbitMQ ports only on `127.0.0.1`.

## Events and transactional outbox

Start the worker and consumer in separate terminals:

```bash
npm run worker:dev
npm run consumer:dev
```

After building, use `npm run worker` and `npm run consumer`. The API can accept orders while RabbitMQ is unavailable: events remain in PostgreSQL until delivery resumes. Event processes reconnect after connection failures and shut down on SIGINT/SIGTERM.

```mermaid
flowchart LR
    API[Order API] --> TX[PostgreSQL transaction]
    TX --> Orders[Orders and inventory]
    TX --> Outbox[Outbox events]
    Outbox --> Worker[Worker with lease]
    Worker -->|persistent message + confirm| Broker[RabbitMQ quorum queue]
    Broker --> Consumer[Consumer]
    Consumer --> Inbox[Inbox and projection transaction]
    Consumer -->|ack after commit| Broker
```

Events contain `eventId`, `version`, `type`, `occurredAt`, and `data`. Supported types are `OrderCreated` and `OrderCancelled`. Events do not include JWTs or personal claims. The migration backfills events for existing orders so the consumer can build projections for data created before the outbox was introduced.

The worker claims an event through `FOR UPDATE SKIP LOCKED`, records a lease, and releases the transaction before contacting the broker. It marks the event `published` after receiving a publisher confirm. The lease token prevents a stale worker from changing a delivery that another worker has reclaimed. Events for one order are published in creation order; a `failed` event blocks later events for that order until an operator resolves the failure.

Worker retries use exponential backoff capped at 5 minutes. Exhausted events become `failed` rather than being deleted. `OUTBOX_LEASE_MS` must exceed the confirmation timeout plus 5 seconds for database work. A crash after broker confirmation but before the database update can cause redelivery: the guarantee is **at least once**, not exactly once.

The consumer records the event ID in `consumed_events` and updates `order_projections` in one transaction. Repeated event IDs do not apply the business effect twice. Cancellation arriving before creation is retried. After a transient failure, the consumer waits for backoff, capped at 30 seconds, publishes a retry with a publisher confirm, and only then acknowledges the original. Invalid messages and exhausted retries go to the durable `orders.projection.dead` queue. The attempt limit applies to each retry lineage; crash duplicates can carry an older retry count.

RabbitMQ Management is available at `http://localhost:15672` with local credentials `orders` / `orders`. The exchange is `orders.events`, routing key is `order`, and queue is `orders.projection`. Queues are quorum queues and messages are persistent. Broker confirmation does not mean consumption has completed. This demo has one projection; add a separate queue and inbox namespace for an independent consumer.

Inspect delivery and projection state:

```bash
docker compose exec -T db psql -U orders -d orders -c \
  "SELECT event_id, event_type, status, attempts, last_error FROM outbox_events ORDER BY sequence;"
docker compose exec -T db psql -U orders -d orders -c \
  "SELECT order_id, status, applied_events FROM order_projections;"
```

After resolving a failed delivery's cause, retry it while preserving the event ID:

```sql
UPDATE outbox_events
SET status = 'pending', attempts = 0, available_at = now(), last_error = NULL
WHERE event_id = '<event UUID>' AND status = 'failed';
```

Completed outbox and inbox records are not deleted automatically. Align retention with the redelivery window; deleting an inbox marker can allow an old message to apply its effect again.

## OpenAPI and examples

Development exposes `http://localhost:3000/docs/` and `http://localhost:3000/openapi.json`. These routes are disabled in production. The standalone contract is `docs/openapi.json`; it includes scopes, pagination parameters, the idempotency header, response schemas, and errors.

```bash
curl http://localhost:3000/api/me -H "Authorization: Bearer $TOKEN"
curl 'http://localhost:3000/api/orders?limit=2&status=created' -H "Authorization: Bearer $TOKEN"
curl -X POST "http://localhost:3000/api/orders/$ORDER_ID/cancel" -H "Authorization: Bearer $TOKEN"

ADMIN_TOKEN=$(npm run --silent token:dev -- manager inventory:write manager)
curl -X PUT 'http://localhost:3000/api/products/7106f556-b21c-4a1f-b155-44327735deae/stock' \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' -d '{"stock":100}'
```

Set `ORDER_ID` to the ID returned when creating an order. To demonstrate 403, generate a token containing only `orders:read` and attempt creation. To test RS256, use an external provider's token with matching issuer/audience and a `scope` claim; the local generator supports HS256 only.

## Verification

```bash
npm run typecheck
npm run build

docker compose exec -T db createdb -U orders orders_test
TEST_DATABASE_URL=postgres://orders:orders@localhost:5432/orders_test \
TEST_AMQP_URL=amqp://orders:orders@localhost:5672 npm test
```

Create `orders_test` only once. Tests use real PostgreSQL, create a random isolated schema, and remove it afterward. `DATABASE_URL` is never a fallback for tests. Coverage includes creation, reads, ownership isolation, parallel retries, concurrent stock reservations, payload conflicts, rollback, retry after insufficient stock, lock timeouts, UUID normalization, JWT/scopes/JWKS, pagination, cancellation, outbox delivery, consumer deduplication, migration backfill, OpenAPI validation, and HTTP errors.

GitHub Actions runs the same checks with PostgreSQL 17 and RabbitMQ 4. Broker tests create isolated exchanges and queues and delete them afterward. JWKS tests use a local HTTP endpoint and do not depend on an external identity provider.

Run the compiled server:

```bash
npm run build
npm start
```

Run migrations separately before starting the API. They are serialized by an advisory lock, applied transactionally, and verify checksums of previously applied files. Add a new SQL file in `db/migrations` for schema changes instead of editing applied migrations.

## Project structure

```text
src/
  app.ts                 # HTTP composition and error handling
  server.ts              # Startup and graceful shutdown
  auth.ts                # HS256 or RS256/JWKS verification
  user.ts                # Typed identity extracted from verified claims
  authorization.ts       # Scope requirements
  inventory.ts           # Authorized absolute stock replacement
  transaction.ts         # Transaction lifecycle and timeout handling
  openapi.ts             # Development-only Swagger UI
  worker.ts              # Outbox publisher process
  consumer.ts            # Idempotent projection consumer
  events/                # Outbox leases, RabbitMQ confirms, consumer inbox
  config.ts              # Environment validation
  database.ts            # Connection pool
  errors.ts              # API errors
  migrate.ts             # Transactional migration runner
  orders/
    contracts.ts         # Runtime validation and response types
    router.ts            # HTTP routes
    service.ts           # Transactional business logic
    pagination.ts        # Validated keyset cursors
db/migrations/           # Versioned SQL schema
scripts/                 # Migrations, demo seed, local JWT
test/                    # HTTP, JWKS, broker, migration and OpenAPI tests
docs/openapi.json        # Standalone HTTP contract
compose.yaml             # Local PostgreSQL and RabbitMQ
```

Each order contains one product. Payments, a shopping cart, and a catalog are outside this example's scope. To replace RabbitMQ with Azure Service Bus, implement another `EventPublisher` while keeping the outbox and idempotent consumption.
