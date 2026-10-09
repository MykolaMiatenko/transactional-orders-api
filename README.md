# Transactional Order API

Проєкт демонструє реалізацію API створення замовлень із транзакційним збереженням даних, атомарним списанням залишків та захистом від повторних запитів. Він показує коректну поведінку під час конкурентних запитів і збоїв, JWT-автентифікацію зі scopes та JWKS, cursor pagination, транзакційне скасування замовлень і надійну доставку подій через outbox. Поведінка перевіряється інтеграційними тестами зі справжніми PostgreSQL і RabbitMQ.

Стек: Node.js, TypeScript, Express 5, PostgreSQL із драйвером `pg`, Zod для валідації, `jose` для перевірки JWT Pino для структурованого логування, RabbitMQ для подій і OpenAPI/Swagger UI для документації.

## Запуск

Потрібні Node.js 22+ та Docker із Compose. Команди виконуються з каталогу проєкту.

```bash
npm ci
cp .env.example .env
docker compose up -d --wait db rabbitmq
npm run db:migrate
npm run db:seed
npm run dev
```

Сервер працює на `http://localhost:3000`. Seed створює товар `7106f556-b21c-4a1f-b155-44327735deae` із ціною 1999 центів і початковим залишком 100. Повторний seed не відновлює списаний залишок.

В іншому терміналі створіть локальний токен і замовлення:

```bash
TOKEN=$(npm run --silent token:dev -- demo-user)
KEY=$(node -e 'console.log(require("node:crypto").randomUUID())')

curl -i http://localhost:3000/api/orders \
  -H "Authorization: Bearer $TOKEN" \
  -H "Idempotency-Key: $KEY" \
  -H "Content-Type: application/json" \
  -d '{"productId":"7106f556-b21c-4a1f-b155-44327735deae","quantity":2}'
```

Очікуваний результат — `201 Created`, заголовок `Location: /api/orders/<id>` та JSON:

```json
{
  "id": "<generated UUID>",
  "productId": "7106f556-b21c-4a1f-b155-44327735deae",
  "quantity": 2,
  "totalCents": 3998
}
```

Повторіть той самий `curl` з тим самим `$KEY`: API поверне той самий JSON і статус 201, а залишок не зміниться вдруге. Для нового замовлення генеруйте новий ключ. Зміна payload із попереднім ключем поверне 409.

## HTTP-контракт

| Метод | Шлях | Призначення |
|---|---|---|
| GET | `/api/me` | Перевірена ідентичність, ролі та scopes поточного користувача |
| GET | `/api/orders` | Власні замовлення з cursor pagination і фільтрами; scope `orders:read` |
| POST | `/api/orders/:id/cancel` | Скасування власного замовлення; scope `orders:cancel`, без тіла |
| PUT | `/api/products/:id/stock` | Заміна залишку: `{ "stock": 100 }`; scope `inventory:write` |
| POST | `/api/orders` | Створити замовлення; потрібні Bearer JWT та UUID `Idempotency-Key` |
| GET | `/api/orders/:id` | Прочитати власне замовлення; потрібен Bearer JWT |
| GET | `/health/live` | Перевірити роботу HTTP-сервера |
| GET | `/health/ready` | Перевірити доступність БД |

Тіло створення допускає лише `productId` (UUID) та `quantity` (ціле число 1–100). Ціна й користувач беруться з БД та перевіреного JWT відповідно. UUID нормалізуються до нижнього регістру. Гроші зберігаються цілими числами в центах.

Помилки мають формат:

```json
{
  "code": "INSUFFICIENT_STOCK",
  "message": "Not enough items in stock.",
  "requestId": "<request UUID>"
}
```

`X-Request-Id` містить той самий ідентифікатор, що й логи запиту. Кожен HTTP-запит отримує новий request ID, включно з повторними запитами.

| Статус | Код | Причина |
|---|---|---|
| 400 | `INVALID_REQUEST` | Некоректне тіло, UUID або відсутній ключ |
| 400 | `INVALID_CURSOR` | Cursor не відповідає формату, користувачу або фільтрам |
| 403 | `FORBIDDEN` | Токен не має потрібного scope |
| 503 | `AUTH_UNAVAILABLE` | JWKS endpoint недоступний або перевищено timeout |
| 400 | `INVALID_JSON` | Невалідний JSON |
| 401 | `UNAUTHORIZED` | Токен відсутній, невалідний або прострочений |
| 404 | `PRODUCT_NOT_FOUND` | Товар не існує |
| 404 | `ORDER_NOT_FOUND` | Замовлення не існує або належить іншому користувачу |
| 404 | `NOT_FOUND` | Невідомий маршрут |
| 409 | `INSUFFICIENT_STOCK` | Недостатній залишок |
| 409 | `IDEMPOTENCY_KEY_REUSED` | Ключ уже використано для іншого payload |
| 413 | `PAYLOAD_TOO_LARGE` | JSON перевищує 16 КБ |
| 415 | `UNSUPPORTED_ENCODING` | Непідтримуване кодування тіла |
| 503 | `DATABASE_BUSY` | Timeout блокування, SQL timeout або конфлікт транзакцій |
| 503 | `DATABASE_UNAVAILABLE` | Відомий збій підключення до БД |
| 503 | `NOT_READY` | БД недоступна для readiness probe |
| 500 | `INTERNAL_ERROR` | Неочікувана помилка; внутрішні деталі не повертаються |

Для 503 API встановлює `Retry-After: 1`. Після timeout, мережевого збою або невизначеного результату повторюйте запит із **тим самим ключем і payload**: транзакція могла вже закомітитися.

## Транзакції та конкурентність

`GET /api/orders?limit=20&status=created&from=2026-01-01T00:00:00Z` повертає `{ "items": [...], "nextCursor": "..." }`. `limit` — 1–100 (типово 20), `status` — `created` або `cancelled`, `from`/`to` — включні ISO 8601 timestamps із часовим поясом. Для наступної сторінки передайте `cursor` та ті самі фільтри. Cursor прив'язаний до користувача і фільтрів; некоректний повертає 400 `INVALID_CURSOR`. Сортування — `(created_at DESC, id DESC)`, timestamps зберігають мікросекунди PostgreSQL. Пагінація не є snapshot: новіші записи після першої сторінки не потрапляють у продовження, а зміни статусу можуть змінити склад відфільтрованого списку.

Читання замовлень повертає також `status` і `createdAt`; результат створення залишається незмінним для ідемпотентних повторів.

`POST /api/orders/:id/cancel` виконує перехід `created → cancelled` і повертає актуальне замовлення з `cancelledAt`. Блокування рядка замовлення, зміна статусу та повернення залишку виконуються в одній транзакції. Повторне скасування повертає 200 і той самий стан без повторного повернення товару. Повтор початкового POST з `Idempotency-Key` після скасування повертає початковий результат створення; для актуального стану використовуйте GET.

`OrderService.create()` виконує всі SQL-запити через один клієнт `pg` в одній транзакції `READ COMMITTED`:

1. Реєструє `(user_id, operation, request_key)` через унікальний ключ БД.
2. Для повторного ключа перевіряє SHA-256 нормалізованого payload і повертає збережений результат.
3. Виконує `UPDATE products ... WHERE stock >= quantity`, щоб атомарно перевірити й списати залишок.
4. Записує замовлення, JSON-відповідь і подію `OrderCreated` в outbox та робить `COMMIT`.

Паралельні повтори координуються PostgreSQL, тому поведінка зберігається для кількох процесів API. `READ COMMITTED` дозволяє наступному `SELECT` побачити результат конкурентної транзакції після очікування унікального ключа. Будь-яка помилка до commit відкочує замовлення, залишок і запис ключа разом. Невдалі бізнес-запити не кешуються. Клієнт звільняється рівно один раз у `finally`; після невдалого rollback з'єднання видаляється з пулу.

Ключі успішних запитів зберігаються без автоматичного TTL. Не видаляйте їх без визначеного бізнесом вікна повторів: після видалення попередній запит може створити ще одне замовлення.

SQL timeout — 5 секунд, timeout блокування — 2 секунди, timeout отримання з'єднання — 3 секунди. При SIGINT/SIGTERM сервер припиняє приймати нові запити, завершує активні й закриває пул; граничний час shutdown — 10 секунд.

## Автентифікація й конфігурація

Авторизація перевіряє точні scopes: `orders:create` для POST, `orders:read` для читання замовлень, `orders:cancel` для скасування, `inventory:write` для зміни залишку. Валідний токен без потрібного дозволу повертає 403 `FORBIDDEN`; невалідний або відсутній токен — 401. Ролі не заміняють scopes. Заміна залишку — абсолютна операція, повторне встановлення того самого значення не додає товар повторно; це адміністративне узгодження фізичного залишку, а не increment.

Локальний генератор: `npm run --silent token:dev -- demo-user "orders:read orders:create orders:cancel" buyer`. Аргументи після `--`: user ID, scopes через пробіли, ролі через кому. Для адміністративного токена явно задайте `inventory:write`; типовий buyer-токен його не містить.

Після перевірки JWT middleware створює типізований контекст `UserContext` із `sub`, `roles` (масив рядків) і `scope` (рядок дозволів через пробіли). `GET /api/me` повертає лише `userId`, `roles`, `scopes`; довільні claims, персональні дані та сам токен у відповідь не потрапляють. Невалідний формат claims повертає 401. Ролі самі по собі не надають доступ до операцій.

JWT перевіряється бібліотекою `jose`: підпис **HS256** або **RS256** згідно з `JWT_MODE`, issuer, audience, `sub`, `iat`, `exp`, термін дії та `nbf`, якщо він заданий. `sub` визначає користувача. Скрипт `token:dev` призначений для локальної розробки, видає токен на годину й вимкнений у production. HTTP endpoint видачі токенів не додається.

Для HS256 перед розгортанням встановіть власний криптографічно випадковий `JWT_SECRET` щонайменше 32 байти та узгодьте issuer/audience із сервісом видачі токенів. Сервер відхиляє демонстраційний секрет у production. Для зовнішнього провайдера задайте `JWT_MODE=RS256`, `JWT_JWKS_URL` (HTTPS), issuer та audience; `JWT_SECRET` у цьому режимі не потрібен. `jose` кешує JWKS, оновлює ключі з урахуванням cooldown і обмежує час HTTP-запиту. Невідомий `kid` або неправильний підпис повертають 401, недоступний endpoint або timeout — 503 `AUTH_UNAVAILABLE`. Fallback між алгоритмами відсутній; URL ключів береться лише з конфігурації.

| Змінна | Призначення | Типове значення |
|---|---|---|
| `DATABASE_URL` | PostgreSQL connection string | Обов'язкова |
| `JWT_SECRET` | Секрет підпису JWT | Обов'язкова для HS256 |
| `JWT_MODE` | Дозволений алгоритм | `HS256` |
| `JWT_JWKS_URL` | Довірений JWKS endpoint | Обов'язкова для RS256 |
| `JWKS_TIMEOUT_MS` | Timeout HTTP JWKS | `3000` |
| `JWKS_COOLDOWN_MS` | Обмеження повторного завантаження | `30000` |
| `JWKS_CACHE_MAX_AGE_MS` | Час кешування ключів | `600000` |
| `JWT_ISSUER` | Очікуваний issuer | `order-api` |
| `JWT_AUDIENCE` | Очікувана audience | `order-api-clients` |
| `PORT` | HTTP-порт | `3000` |
| `DB_POOL_MAX` | Максимум з'єднань API | `10` |
| `NODE_ENV` | `development`, `test`, `production` | `development` |
| `LOG_LEVEL` | Рівень логів Pino | `info` |
| `AMQP_URL` | RabbitMQ connection string | `amqp://orders:orders@localhost:5672` |
| `OUTBOX_POLL_MS` | Пауза worker за відсутності подій | `1000` |
| `OUTBOX_LEASE_MS` | Строк блокування доставки | `30000` |
| `OUTBOX_MAX_ATTEMPTS` | Максимум спроб доставки | `5` |
| `OUTBOX_BACKOFF_MS` | Початкова затримка повтору | `1000` |
| `AMQP_CONFIRM_TIMEOUT_MS` | Timeout publisher confirm | `5000` |
| `CONSUMER_MAX_ATTEMPTS` | Спроби обробки до dead queue | `5` |
| `TEST_DATABASE_URL` | Окрема БД для інтеграційних тестів | Обов'язкова для `npm test` |
| `TEST_AMQP_URL` | Тестовий RabbitMQ | Обов'язкова для `npm test` |

Для remote PostgreSQL використовуйте TLS із перевіркою сертифіката згідно з конфігурацією провайдера; наприклад, задайте `sslmode=verify-full` і довірений CA у connection string. Локальний Compose призначений для розробки та публікує PostgreSQL лише на `127.0.0.1`.

## Події та transactional outbox

Запустіть окремо worker і споживача (у різних терміналах):

```bash
npm run worker:dev
npm run consumer:dev
```

Після збірки доступні `npm run worker` і `npm run consumer`. API може приймати замовлення під час недоступності RabbitMQ: події залишаються в PostgreSQL до відновлення доставки. Процеси перепідключаються після розриву з'єднання та завершуються за SIGINT/SIGTERM.

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

Події мають `eventId`, `version`, `type`, `occurredAt`, `data`; типи — `OrderCreated` і `OrderCancelled`. Вони не містять JWT або персональних claims. Міграція backfill створює події для наявних замовлень, тому споживач може побудувати проєкцію й для даних, створених до впровадження outbox.

Worker отримує подію через `FOR UPDATE SKIP LOCKED`, реєструє lease та звільняє транзакцію перед зверненням до брокера. Після publisher confirm позначає подію `published`. Token lease не дає старому worker змінити вже перехоплену доставку. Події одного замовлення публікуються в порядку створення; подія зі статусом `failed` блокує наступні події цього замовлення, поки оператор не усуне причину.

Повтори worker використовують exponential backoff до 5 хвилин. Після ліміту спроб запис стає `failed`, а не видаляється. `OUTBOX_LEASE_MS` має перевищувати timeout підтвердження плюс 5 секунд для БД. Під час збою після broker confirm, але до запису в БД, можлива повторна доставка — гарантія **at least once**, не exactly once.

Споживач у транзакції записує event ID у `consumed_events` та змінює `order_projections`. Повторний event ID не застосовує бізнес-ефект удруге. Якщо скасування прийшло раніше створення, повідомлення повторюється. Після transient помилки споживач очікує backoff (до 30 секунд), публікує повтор із publisher confirm і лише тоді підтверджує оригінал. Невалідні повідомлення та вичерпані спроби потрапляють у durable queue `orders.projection.dead`; максимальна кількість спроб стосується кожного ланцюжка повторів, дублікати після crash можуть мати старіший retry count.

RabbitMQ Management: `http://localhost:15672`, локальні credentials — `orders` / `orders`. Основний exchange — `orders.events`, routing key — `order`, queue — `orders.projection`. Queues — quorum, повідомлення — persistent; підтвердження брокера не означає завершення споживання. Топологія цього demo використовує одну проєкцію; для незалежного споживача додайте власну queue та inbox namespace.

Для перевірки результатів:

```bash
docker compose exec -T db psql -U orders -d orders -c \
  "SELECT event_id, event_type, status, attempts, last_error FROM outbox_events ORDER BY sequence;"
docker compose exec -T db psql -U orders -d orders -c \
  "SELECT order_id, status, applied_events FROM order_projections;"
```

Після усунення причини failed-доставки її можна повторити, зберігши той самий event ID:

```sql
UPDATE outbox_events
SET status = 'pending', attempts = 0, available_at = now(), last_error = NULL
WHERE event_id = '<event UUID>' AND status = 'failed';
```

Завершені записи outbox та inbox автоматично не видаляються. Retention потрібно узгодити з вікном повторної доставки; видалення inbox може дозволити повторне застосування старого повідомлення.

## OpenAPI та приклади

У development доступні `http://localhost:3000/docs/` і `http://localhost:3000/openapi.json`. У production ці маршрути вимкнені. Standalone контракт — `docs/openapi.json`; він містить scopes, параметри пагінації, idempotency header, схеми відповідей і помилок.

```bash
curl http://localhost:3000/api/me -H "Authorization: Bearer $TOKEN"
curl 'http://localhost:3000/api/orders?limit=2&status=created' -H "Authorization: Bearer $TOKEN"
curl -X POST "http://localhost:3000/api/orders/$ORDER_ID/cancel" -H "Authorization: Bearer $TOKEN"

ADMIN_TOKEN=$(npm run --silent token:dev -- manager inventory:write manager)
curl -X PUT 'http://localhost:3000/api/products/7106f556-b21c-4a1f-b155-44327735deae/stock' \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' -d '{"stock":100}'
```

`ORDER_ID` береться з відповіді створення замовлення. Для демонстрації 403 згенеруйте токен лише з `orders:read` і спробуйте POST. Щоб перевірити RS256, використайте токен зовнішнього провайдера з налаштованими issuer/audience та claim `scope`; локальний генератор працює лише з HS256.

## Перевірки

```bash
npm run typecheck
npm run build

docker compose exec -T db createdb -U orders orders_test
TEST_DATABASE_URL=postgres://orders:orders@localhost:5432/orders_test \
TEST_AMQP_URL=amqp://orders:orders@localhost:5672 npm test
```

Створення `orders_test` потрібне лише один раз. Тести використовують справжній PostgreSQL, окрему випадкову schema та видаляють її після завершення. `DATABASE_URL` ніколи не використовується як fallback для тестів. Покрито створення, читання й ізоляцію користувачів, паралельні повтори, конкурентне списання залишків, конфлікт payload, rollback після помилки вставки, retry після нестачі товару, SQL lock timeout, UUID casing, JWT, валідацію та HTTP-помилки.

GitHub Actions запускає ті самі перевірки з PostgreSQL 17 і RabbitMQ 4. Тести брокера створюють окремі exchange та queues і видаляють їх після завершення. Перевірки JWKS використовують локальний HTTP endpoint і не залежать від зовнішнього identity provider.

Для запуску зібраного сервера:

```bash
npm run build
npm start
```

Міграції запускаються окремою командою перед стартом API. Вони серіалізуються advisory lock, застосовуються транзакційно й перевіряють checksum уже виконаних файлів. Зміни схеми оформлюйте новим SQL-файлом у `db/migrations`, не редагуючи застосовані міграції.

## Структура

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

Проєкт реалізує замовлення одного товару за запит. Оплата, кошик і каталог не входять у цей сценарій. Для переходу з RabbitMQ на Azure Service Bus реалізуйте інший `EventPublisher`, зберігши outbox і ідемпотентну обробку.
