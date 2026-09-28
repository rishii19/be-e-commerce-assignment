# Reliable Checkout & Rewards Service

A backend service for carts, checkout, orders, and milestone-based discount
coupons, built to stay correct under retries and concurrent requests — not
just on the happy path. See [DECISIONS.md](./DECISIONS.md) for the
invariants, ambiguities, and trade-offs behind the design.

## Stack

- **Node.js 22.5+** (developed/tested on Node 24) running **TypeScript
  directly** — no build step, no bundler. Node's native type-stripping runs
  `.ts` files as-is.
- **Express** for HTTP routing.
- **`node:sqlite`** (Node's built-in `DatabaseSync`) for persistence — an
  embedded, transactional database with **no native compilation and no
  Docker/Postgres required**. See DECISIONS.md for why this was chosen over
  better-sqlite3 or a containerized Postgres.
- **Node's built-in test runner** (`node --test`) for automated tests — no
  Jest/Vitest/supertest dependency.

No external services, accounts, or credentials are required to run or test
this project.

## Setup & run

```bash
npm install
npm start
```

The server listens on `http://localhost:3000` by default. On first boot it
creates `./data/app.db` (SQLite file) and seeds 5 products automatically if
the `products` table is empty — no separate seed step is required, but one
is available:

```bash
npm run seed        # idempotent: no-ops if products already exist
```

Other scripts:

```bash
npm run dev          # start with --watch for local development
npm run typecheck    # tsc --noEmit
npm test             # runs the full test suite (uses an in-memory DB)
```

### Configuration (environment variables, all optional)

| Variable                    | Default        | Meaning                                   |
| ---------------------------- | -------------- | ------------------------------------------ |
| `PORT`                       | `3000`         | HTTP port                                 |
| `DB_PATH`                    | `./data/app.db`| SQLite file path (`:memory:` also works)  |
| `COUPON_MILESTONE_N`         | `5`            | Every Nth successful order earns a coupon |
| `COUPON_DISCOUNT_PERCENT`    | `10`           | Percent-off applied by generated coupons  |

## Seed data

Five products are seeded on first boot (see `src/db/seed.ts`), one with
deliberately scarce inventory so oversell protection is easy to exercise:

| id | name                    | price     | inventory |
| -- | ----------------------- | --------- | --------- |
| 1  | Wireless Mouse          | $24.99    | 100       |
| 2  | Mechanical Keyboard     | $89.99    | 50        |
| 3  | USB-C Hub               | $45.99    | 75        |
| 4  | 27-inch Monitor         | $249.99   | 20        |
| 5  | Limited Edition Desk Mat| $19.99    | **2**     |

## Trying it out

- **Web UI** — a minimal test frontend (plain HTML/CSS/JS, no build step) is
  served at `http://localhost:3000/`. It covers the full flow: create a
  cart, add/update/remove items, check out (with an auto-filled idempotency
  key and optional coupon code), and trigger the admin actions.
- **Swagger UI** — interactive API docs generated from `openapi.yaml`, with
  a "Try it out" form for every endpoint, are served at
  `http://localhost:3000/docs`.

## API documentation

Full request/response/status-code documentation is in
[`openapi.yaml`](./openapi.yaml). Endpoints marked **(Admin)** below are
treated as administrator-only operations; no authentication/authorization
is implemented per the assignment's scope.

| Method | Path                              | Purpose                              |
| ------ | --------------------------------- | ------------------------------------- |
| GET    | `/products`                       | List products                        |
| GET    | `/products/:id`                   | Get one product                      |
| POST   | `/carts`                          | Create a cart                        |
| GET    | `/carts/:cartId`                  | View a cart (live prices/totals)     |
| POST   | `/carts/:cartId/items`            | Add an item                          |
| PATCH  | `/carts/:cartId/items/:productId` | Change an item's quantity            |
| DELETE | `/carts/:cartId/items/:productId` | Remove an item                       |
| POST   | `/carts/:cartId/checkout`         | Check out (requires `Idempotency-Key`)|
| GET    | `/orders/:orderId`                | Retrieve an order                    |
| POST   | `/admin/coupons/generate`         | **(Admin)** Generate a milestone coupon |
| GET    | `/admin/report`                   | **(Admin)** Reporting summary        |

## Walkthrough (curl)

```bash
BASE=http://localhost:3000

# Create a cart and add items
CART_ID=$(curl -s -X POST $BASE/carts | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).id))")
curl -s -X POST $BASE/carts/$CART_ID/items -H "Content-Type: application/json" \
  -d '{"productId": 1, "quantity": 2}'

# View the cart (live prices + computed subtotal)
curl -s $BASE/carts/$CART_ID

# Check out — Idempotency-Key is required
curl -s -X POST $BASE/carts/$CART_ID/checkout \
  -H "Content-Type: application/json" -H "Idempotency-Key: order-1" -d '{}'

# Retry the exact same request (simulating a client timeout) — replays the
# same order instead of creating a second one or double-decrementing stock
curl -s -X POST $BASE/carts/$CART_ID/checkout \
  -H "Content-Type: application/json" -H "Idempotency-Key: order-1" -d '{}'

# Admin: generate a coupon once the configured milestone is reached
curl -s -X POST $BASE/admin/coupons/generate

# Checkout with a coupon code
curl -s -X POST $BASE/carts/$CART_ID/checkout \
  -H "Content-Type: application/json" -H "Idempotency-Key: order-2" \
  -d '{"couponCode": "MILESTONE-1-XXXXXXXX"}'

# Admin report (safe to call repeatedly; never mutates state)
curl -s $BASE/admin/report
```

## Testing

```bash
npm test
```

Runs against a fresh in-memory SQLite database per test file (no shared
state between files, no cleanup needed). The suite includes, beyond
sequential happy-path checks:

- **`checkout-concurrency.test.ts`** — 5 concurrent checkouts racing for a
  product with inventory = 2; asserts exactly 2 succeed and inventory never
  goes negative.
- **`checkout-idempotency.test.ts`** — sequential and concurrent retries of
  the same checkout request (same `Idempotency-Key`) produce exactly one
  order; reusing a key with a different cart/coupon is rejected as a
  conflict.
- **`coupon-concurrency.test.ts`** — two admin "generate coupon" calls
  racing for the same milestone produce exactly one coupon; two concurrent
  checkouts racing to redeem the same coupon code produce exactly one
  redemption.
- **`coupon.test.ts`** — a coupon is not consumed by a checkout that
  ultimately fails, and discount rounding is asserted to an exact cent
  value.
- **`report.test.ts`** — the admin report reconciles against orders/coupons
  actually created, and repeated calls return identical output.

## Persistence & concurrency model (summary)

This runs as a single Node process against a single embedded SQLite
database. Because `node:sqlite`'s `DatabaseSync` is synchronous and Node is
single-threaded, an entire checkout (validate → decrement inventory →
redeem coupon → create order) executes as one uninterruptible unit inside a
`BEGIN IMMEDIATE` transaction — no other request can interleave with it.
That is what makes the concurrency tests above pass deterministically.

This does **not** hold across multiple processes/instances or with a
client/server database like Postgres accessed over the network — see
"How this would evolve for multiple instances" in DECISIONS.md for the
migration path (row-level locking / `SELECT ... FOR UPDATE`, or serializable
transactions with retry, plus the same idempotency-key and unique-constraint
backstops carrying over unchanged).

## Time spent

Approximately 5–6 hours of focused work (AI-assisted; see DECISIONS.md for
how AI was used and an example of correcting its output).
