# Transactional Order API

Проєкт демонструє реалізацію API створення замовлень із транзакційним збереженням даних, атомарним списанням залишків та захистом від повторних запитів. Він показує коректну поведінку під час конкурентних запитів і збоїв, JWT-автентифікацію, валідацію вхідних даних та інтеграційне тестування зі справжньою базою даних.

Стек: Node.js, TypeScript, Express 5, PostgreSQL із драйвером `pg`, Zod для валідації, `jose` для перевірки JWT та Pino для структурованого логування.

## Запуск

Потрібні Node.js 22+ та Docker із Compose. Команди виконуються з каталогу проєкту.

```bash
npm ci
cp .env.example .env
docker compose up -d --wait db
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

`OrderService.create()` виконує всі SQL-запити через один клієнт `pg` в одній транзакції `READ COMMITTED`:

1. Реєструє `(user_id, operation, request_key)` через унікальний ключ БД.
2. Для повторного ключа перевіряє SHA-256 нормалізованого payload і повертає збережений результат.
3. Виконує `UPDATE products ... WHERE stock >= quantity`, щоб атомарно перевірити й списати залишок.
4. Записує замовлення та JSON-відповідь і робить `COMMIT`.

Паралельні повтори координуються PostgreSQL, тому поведінка зберігається для кількох процесів API. `READ COMMITTED` дозволяє наступному `SELECT` побачити результат конкурентної транзакції після очікування унікального ключа. Будь-яка помилка до commit відкочує замовлення, залишок і запис ключа разом. Невдалі бізнес-запити не кешуються. Клієнт звільняється рівно один раз у `finally`; після невдалого rollback з'єднання видаляється з пулу.

Ключі успішних запитів зберігаються без автоматичного TTL. Не видаляйте їх без визначеного бізнесом вікна повторів: після видалення попередній запит може створити ще одне замовлення.

SQL timeout — 5 секунд, timeout блокування — 2 секунди, timeout отримання з'єднання — 3 секунди. При SIGINT/SIGTERM сервер припиняє приймати нові запити, завершує активні й закриває пул; граничний час shutdown — 10 секунд.

## Автентифікація й конфігурація

Авторизація перевіряє точні scopes: `orders:create` для POST, `orders:read` для GET, `inventory:write` для зміни залишку. Валідний токен без потрібного дозволу повертає 403 `FORBIDDEN`; невалідний або відсутній токен — 401. Ролі не заміняють scopes. Заміна залишку — абсолютна операція, повторне встановлення того самого значення не додає товар повторно; це адміністративне узгодження фізичного залишку, а не increment.

Локальний генератор: `npm run --silent token:dev -- demo-user "orders:read orders:create orders:cancel" buyer`. Третій аргумент — scopes через пробіли, четвертий — ролі через кому. Для адміністративного токена явно задайте `inventory:write`; типовий buyer-токен його не містить.

Після перевірки JWT middleware створює типізований контекст `UserContext` із `sub`, `roles` (масив рядків) і `scope` (рядок дозволів через пробіли). `GET /api/me` повертає лише `userId`, `roles`, `scopes`; довільні claims, персональні дані та сам токен у відповідь не потрапляють. Невалідний формат claims повертає 401. Ролі самі по собі не надають доступ до операцій.

JWT перевіряється бібліотекою `jose`: підпис **HS256** або **RS256** згідно з `JWT_MODE`, issuer, audience, `sub`, `iat`, `exp`, термін дії та `nbf`, якщо він заданий. `sub` визначає користувача. Скрипт `token:dev` призначений для локальної розробки, видає токен на годину й вимкнений у production. HTTP endpoint видачі токенів не додається.

Перед розгортанням встановіть власний криптографічно випадковий `JWT_SECRET` щонайменше 32 байти та узгодьте issuer/audience із сервісом видачі токенів. Сервер відхиляє демонстраційний секрет у production. Для зовнішнього провайдера задайте `JWT_MODE=RS256`, `JWT_JWKS_URL` (HTTPS), issuer та audience; `JWT_SECRET` у цьому режимі не потрібен. `jose` кешує JWKS, оновлює ключі з урахуванням cooldown і обмежує час HTTP-запиту. Невідомий `kid` або неправильний підпис повертають 401, недоступний endpoint або timeout — 503 `AUTH_UNAVAILABLE`. Fallback між алгоритмами відсутній; URL ключів береться лише з конфігурації.

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
| `TEST_DATABASE_URL` | Окрема БД для інтеграційних тестів | Обов'язкова для `npm test` |

Для remote PostgreSQL використовуйте TLS із перевіркою сертифіката згідно з конфігурацією провайдера; наприклад, задайте `sslmode=verify-full` і довірений CA у connection string. Локальний Compose призначений для розробки та публікує PostgreSQL лише на `127.0.0.1`.

## Перевірки

```bash
npm run typecheck
npm run build

docker compose exec -T db createdb -U orders orders_test
TEST_DATABASE_URL=postgres://orders:orders@localhost:5432/orders_test npm test
```

Створення `orders_test` потрібне лише один раз. Тести використовують справжній PostgreSQL, окрему випадкову schema та видаляють її після завершення. `DATABASE_URL` ніколи не використовується як fallback для тестів. Покрито створення, читання й ізоляцію користувачів, паралельні повтори, конкурентне списання залишків, конфлікт payload, rollback після помилки вставки, retry після нестачі товару, SQL lock timeout, UUID casing, JWT, валідацію та HTTP-помилки.

GitHub Actions запускає ті самі перевірки з PostgreSQL 17.

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
  auth.ts                # Verified JWT authentication
  config.ts              # Environment validation
  database.ts            # Connection pool
  errors.ts              # API errors
  migrate.ts             # Transactional migration runner
  orders/
    contracts.ts         # Runtime validation and response types
    router.ts            # HTTP routes
    service.ts           # Transactional business logic
db/migrations/           # Versioned SQL schema
scripts/                 # Migrations, demo seed, local JWT
test/api.test.ts         # PostgreSQL integration and concurrency tests
compose.yaml             # Local PostgreSQL
```

Проєкт реалізує замовлення одного товару за запит. Оплата, кошик, каталог і публікація подій не входять у цей сценарій. Якщо з'явиться вимога відправляти події до Azure Service Bus, додайте transactional outbox у транзакцію створення замовлення.
