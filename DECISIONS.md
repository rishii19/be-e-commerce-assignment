# DECISIONS.md

Approximate time spent: **5–6 hours**, AI-assisted (see "How AI was used"
below). Nothing described here as "implemented" is untested — the test
suite in `tests/` exercises every invariant listed below, including under
concurrency.

## System invariants

These are the properties the implementation is built to hold at all times,
concurrent or repeated requests included:

1. `products.inventory` never goes negative.
2. A cart transitions `OPEN -> CHECKED_OUT` at most once; once checked out,
   its items can no longer be modified and it cannot produce a second order.
3. An order's line items (product name, unit price, quantity) are a
   permanent snapshot, independent of later changes to `products`.
4. All money is integer cents; no floating-point currency arithmetic exists
   anywhere in the codebase.
5. A discount can never make an order total negative (enforced structurally:
   percent-off is capped at 100 and rounding floors toward zero discount).
6. A coupon is redeemed at most once (`AVAILABLE -> REDEEMED`, one-way).
7. A coupon is never consumed by a checkout that ultimately fails — coupon
   redemption and order creation succeed or fail together, atomically.
8. At most one coupon is ever generated per reward milestone.
9. Retrying an identical checkout request (same `Idempotency-Key`) never
   creates a second order or double-decrements inventory, no matter how many
   times or how concurrently it is retried.
10. The admin report is a pure read over `orders` / `order_lines` /
    `coupons` — it has no separate counters to drift out of sync, and
    calling it repeatedly never changes system state.

## Ambiguities found and the semantics I chose

- **What counts as "administrator"?** No auth is implemented (per scope).
  `POST /admin/coupons/generate` and `GET /admin/report` are grouped under
  `/admin` and documented as the two operations a real deployment would
  gate behind an admin role.
- **Can more than one coupon apply to a single order?** The spec says "a
  valid coupon may be supplied at checkout" (singular) — I treat it as at
  most one coupon per order.
- **Do coupons expire?** Not specified; I chose no expiry. Documented as
  deferred, not silently ignored (see "Deferred").
- **Is `quantity: 0` on `PATCH .../items/:productId` a way to remove an
  item?** I rejected this as ambiguous (0 could mean "remove" or "invalid
  input") and require `DELETE` for removal; `PATCH` requires an integer
  `>= 1`.
- **What HTTP status distinguishes "cart already checked out" from other
  conflicts?** I standardized on `409` for every state-conflict case
  (already-checked-out cart, insufficient inventory, already-redeemed
  coupon, milestone not yet eligible) and `422` specifically for
  idempotency-key reuse with a different request, since that is a client
  protocol error rather than a business-state conflict.
- **Milestone numbering.** Milestones are numbered 1, 2, 3, ... in the order
  they're reached (order count `>= milestone * n`), not by the raw order
  count itself, so `n = 5` means milestone 1 at order 5, milestone 2 at
  order 10, etc.
- **Retrying checkout on the same cart with no/different idempotency key.**
  These are two distinct cases, not one, because the missing-header check
  runs unconditionally before the cart-status check
  (`checkout.service.ts:41-46` and `:71-78`):
  - **Omitting the `Idempotency-Key` header entirely** always returns
    `400 IDEMPOTENCY_KEY_REQUIRED`, regardless of the cart's status — a key
    is required to attempt checkout at all, so this short-circuits before
    the cart is even looked up.
  - **Supplying a *different* key on a cart that has already been checked
    out** returns `409 CART_ALREADY_CHECKED_OUT`, with the existing order id
    in `details`, rather than silently returning the prior order — only an
    *exact* key match (same key, same request hash) is treated as "this is
    the same request, replay it."

## Decision: Persistence — `node:sqlite` instead of better-sqlite3 or Postgres+Docker

**Context:** Needed a database that demonstrates real transactional/ACID
behavior under concurrency, is trivial for a reviewer to run, and has no
external dependency.

**Options considered:**
1. Postgres in Docker — closest to a "real" production setup.
2. better-sqlite3 (synchronous, embedded, the de facto standard for this
   kind of demo).
3. Node's built-in `node:sqlite` (`DatabaseSync`), stable enough as of
   Node 22.5+/24.
4. A plain in-memory JS data structure with manual locking.

**Choice:** `node:sqlite`.

**Why:** The evaluation environment for this build had no Docker installed,
ruling out (1). (2) was my first instinct, but better-sqlite3 ships a
native addon that must be compiled (node-gyp) or matched to a prebuilt
binary for the exact Node ABI/platform — a real risk on a fresh machine with
an unconfirmed C++ toolchain, and directly against the "no dependency on
private services or credentials" / "repeatable setup" requirement. I
verified `node:sqlite` works with zero native build step on this Node 24
install before committing to it. (4) would have thrown away real
transaction semantics for no benefit. `node:sqlite` gives (2)'s synchronous,
transactional properties with (1)'s "it's a real database" credibility, at
zero extra install risk.

**Consequences:** Setup is `npm install && npm start` with no compiler, no
container runtime, no network dependency beyond the initial `npm install`.
The trade-off is that `node:sqlite` is a newer, less battle-tested API than
better-sqlite3 or Postgres, and is single-writer/single-process by
construction (see the concurrency decision below for how that's actually
turned into a feature here, and what changes if that stops being true).

## Decision: Concurrency strategy — synchronous single-process transactions instead of explicit row locks

**Context:** Needed checkout, coupon redemption, and coupon generation to
be safe under concurrent and retried requests, without a lock manager.

**Options considered:**
1. Explicit optimistic concurrency (version columns + compare-and-swap
   retries).
2. Explicit pessimistic locking (`SELECT ... FOR UPDATE`-style row locks —
   not directly available in SQLite).
3. Lean on the fact that Node is single-threaded and `node:sqlite`'s
   `DatabaseSync` is fully synchronous.

**Choice:** (3), with (1)-style guarded updates (`UPDATE ... WHERE
<precondition>`, checking `changes === 1`) as defense-in-depth on top.

**Why:** Every checkout and coupon-generation handler runs as one
synchronous function with **no `await`** in its critical section, wrapped
in `withTransaction` (`BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK` —
`src/db/connection.ts`). Node's event loop cannot start a second request's
JS until the first one's synchronous call stack returns, so two "concurrent"
HTTP requests can never actually interleave their reads and writes within
this process — the second one's logic always starts strictly after the
first one's transaction has committed or rolled back. This gives
serializable isolation for free, for a single process. I still guard every
mutating statement with a `WHERE` precondition and check the affected-row
count (`markCartCheckedOut`, `decrementInventory`, `markCouponRedeemed`,
`UNIQUE(milestone_number)`) — not because it's reachable today, but because
it documents the invariant explicitly and is exactly what keeps holding
correctly the day this database gets a second writer.

**Consequences:** No lock-timeout handling, no retry-on-conflict loops, and
no dependency on SQLite features it doesn't have — at the cost of a design
that is only correct as a *single process*. Scaling to multiple instances
requires revisiting this (see "How this evolves" below); the guarded
updates and unique constraints are exactly the parts of this design that
carry over unchanged.

## Decision: Idempotent checkout via a required `Idempotency-Key` header

**Context:** "Clients may retry a checkout request... a retry must not
accidentally create another order or charge inventory twice."

**Options considered:**
1. Make the cart id itself the sole idempotency boundary (cart can only be
   checked out once, so just rely on the `OPEN -> CHECKED_OUT` transition).
2. Require an explicit client-supplied `Idempotency-Key` header, matched
   against a hash of the meaningful request fields (cart id + coupon code),
   Stripe-style.
3. Server-generates an idempotency key from the request body only (no
   header), risking collisions between unrelated requests with identical
   bodies.

**Choice:** (2), layered on top of (1) rather than instead of it.

**Why:** (1) alone would already prevent a *second order* from ever being
created, but it can't distinguish "this is the same request retried" from
"a second, different attempt to check out an already-closed cart" — the
latter should arguably return the original order to the client rather than
an opaque conflict. An explicit key, scoped to a hash of `(cartId,
couponCode)`, lets the server safely replay the exact prior response only
when it's confident it's the same logical request, and reject key reuse
across a different cart/coupon as a client error (`422`) rather than
silently doing the wrong thing.

**Consequences:** Clients must generate and persist a key per checkout
attempt (documented in the API docs) — a small burden that buys an
unambiguous retry contract. Only **successful** (`201`) responses are
cached under the key; failed validation (bad coupon, insufficient
inventory, etc.) rolls back the whole transaction including the
idempotency record, so a failed attempt is safe to simply retry fresh, and
a later retry can legitimately succeed once the underlying condition
changes (e.g. someone else's cart's checkout fails and frees up stock).
A `orders.cart_id UNIQUE` constraint and the cart's one-way status
transition are a structural third layer, so a duplicate order is impossible
even if the idempotency bookkeeping above it had a bug.

## Decision: Live pricing, snapshotted only at checkout

**Context:** "Decide and document what happens when product price or
availability changes after an item was added but before checkout."

**Options considered:**
1. Snapshot price/availability at add-to-cart time; reconcile or fail at
   checkout if they've since diverged.
2. Cart items store only `(productId, quantity)`; price and availability
   are always read live from `products`, and `GET /carts/:id` always shows
   current numbers. Checkout locks in whatever is current at that instant.

**Choice:** (2).

**Why:** (1) requires deciding a whole secondary policy the spec doesn't
ask for (how much drift is tolerable, what error to show, whether to
auto-update or block checkout) for a benefit the API design already
provides for free: since `GET /carts/:id` always reflects current data, a
client that fetches the cart immediately before confirming checkout is
never shown stale numbers. Checkout is still the sole point where price and
availability are authoritative and locked into the order snapshot.

**Consequences:** Simpler cart model (no staleness bookkeeping), but a cart
gives no guarantee that the price you saw a while ago is the price you'll
be charged — only the price at the moment of `GET`/checkout is meaningful.
This is called out in the API docs.

## Decision: No inventory reservation on add-to-cart

**Context:** Related to the above — should adding an item to a cart place a
hold on stock?

**Options considered:**
1. Reserve stock on add, with a TTL/expiry to release abandoned holds.
2. No reservation; only checkout enforces the inventory invariant.

**Choice:** (2), with an advisory (non-authoritative) check at add-time that
rejects a quantity that already exceeds current stock, purely for a better
error message before the customer reaches checkout.

**Why:** A reservation system needs an expiry policy, a background sweep or
lazy-expiry check, and a decision about what happens to *other* customers'
carts holding the same scarce item — real scope, not requested by the spec,
and not needed to satisfy "the system must not sell more inventory than is
available" (that's a checkout-time guarantee, which is enforced
unconditionally). Documented as intentionally deferred.

**Consequences:** Two customers can simultaneously have "2 of the last 2
units" in their carts; only one will succeed at checkout, and the other
gets a clear `409 INSUFFICIENT_INVENTORY` — which is exactly what the
concurrency test suite exercises and asserts.

## Decision: Coupon milestone generation is one milestone per call

**Context:** "A coupon is generated only if the configured order milestone
has been reached and a coupon has not already been generated for that
milestone" — ambiguous about what happens if several milestones have been
reached without anyone calling generate.

**Options considered:**
1. One admin call retroactively generates coupons for *every* newly
   eligible milestone.
2. One admin call generates *at most one* coupon, for the lowest-numbered
   ungenerated milestone; catching up requires calling again.

**Choice:** (2).

**Why:** (1) means a single admin call's response shape has to describe a
variable-length batch, and it's not obvious that's what an administrator
expects from "generate a coupon" (singular, per the spec's own wording).
(2) keeps the operation's response a single coupon, keeps the audit trail
of *when* each coupon was generated meaningful (one call = one coupon), and
is trivial to reason about and test.

**Consequences:** An administrator who calls this rarely will need to call
it multiple times to catch up on several missed milestones — a minor UX
cost for a clearer contract. `UNIQUE(milestone_number)` backstops this
against a concurrent double-call for the same milestone (see the
concurrency decision above).

## Decision: Money as integer cents, discount rounds down (floor)

**Context:** "Calculate money without floating-point rounding errors" /
"Discount calculations must be deterministic and must never make an order
total negative."

**Options considered:**
1. Floating-point (`float`/`double`) arithmetic for money — the conventional
   default, but introduces non-deterministic rounding drift, which the spec
   explicitly warns against.
2. Integer cents with the discount rounded to the nearest cent — deterministic,
   but can round in the customer's favor, weakening the "customer never
   charged less than `100 - percentOff` percent" guarantee to an
   approximation rather than a structural fact.
3. Integer cents with the discount rounded up (ceiling) — could let a
   discount exceed the configured `percentOff`, working against a
   conservative-for-the-business rounding rule.
4. Integer cents with the discount floored (chosen) — deterministic, and the
   discount can structurally never exceed the configured percentage.

**Choice:** All prices, totals, and discounts are `INTEGER` cents in SQLite
and `number` (safe integer range) in TypeScript — never `float`/`double`
arithmetic on currency. Discount is `floor(subtotalCents * percentOff /
100)`; total is `subtotalCents - discountCents` (this can never be negative
given `percentOff` is constrained to `(0, 100]` at config-load time, but a
`Math.max(0, ...)` floor is kept in `domain/money.ts` as a second guard).

**Why:** Floor (never round-to-nearest or ceiling) guarantees the customer
is never charged less than `100 - percentOff` percent of the subtotal — a
deterministic, conservative-for-the-business rounding rule that's trivial
to justify and to test (`tests/coupon.test.ts` asserts an exact cent value:
2499 cents at 10% off floors to a 249-cent discount, not 250).

**Consequences:** All arithmetic is exact integer math; there's no
floating-point drift to reason about anywhere in the codebase.

## Decision: Error model — single envelope, stable string codes

**Context:** "Return errors that are distinguishable and useful to an API
client."

**Options considered:**
1. Rely on HTTP status codes alone, with no body-level code — simple, but
   several distinct business conditions collapse onto the same status
   (`409` alone covers already-checked-out, insufficient inventory, and
   already-redeemed-coupon), leaving a client unable to distinguish them.
2. Free-form, human-readable message strings for clients to parse — brittle,
   since message text isn't a stable contract and is easy to change
   accidentally.
3. Per-route/ad hoc error body shapes — inconsistent across endpoints and
   harder to assert against uniformly in tests.
4. A single envelope with a fixed, closed set of string codes (chosen) —
   machine-readable, consistent across every route, and directly assertable.

**Choice:** Every error response is `{ error: { code, message, details? } }`
with a fixed set of string `code`s (`domain/errors.ts`) mapped to HTTP
status (400 validation, 404 not-found, 409 state conflict, 422 idempotency
misuse, 500 unexpected). Clients should branch on `code`, not on `message`
text or HTTP status alone (`409` covers several distinct business
conditions).

**Why:** A closed set of machine-readable codes is both easier to test
against (the whole test suite asserts on `error.code`) and easier for a
real API client to build reliable retry/branch logic on than parsing
prose or overloading a handful of HTTP status codes.

**Consequences:** Adding a new failure mode means adding a new code to one
place (`ErrorCode`) rather than inventing ad hoc shapes per route.

## Decision: Payment — no payment step, checkout success *is* payment success

**Context:** The spec explicitly allows treating successful checkout as
payment success, or introducing a small payment abstraction.

**Options considered:**
1. No payment abstraction; checkout success is payment success (chosen).
2. A synchronous, always-succeeds stub payment step — adds a
   `PENDING_PAYMENT`-like state and transition with no corresponding
   business rule to test against, i.e. untested scaffolding.
3. A fully async payment gateway with webhook-driven confirmation
   (`PENDING` order, inventory soft-held, confirmed later) — the realistic
   production shape, but a materially bigger change than the stated timebox
   allows and not required by the spec.

**Choice:** No payment abstraction. `POST /checkout` succeeding **is** the
"payment succeeded" event; there is no separate payment-pending state or
async confirmation.

**Why:** Introducing a fake payment gateway (even a synchronous, always-
succeeds stub) would add a state (e.g. `PENDING_PAYMENT`) and a transition
with no corresponding business rule to test against — the spec doesn't ask
for partial-payment, refund, or payment-failure semantics, so a stub would
be untested scaffolding rather than a demonstrated capability. Given the
timebox, I judged this not worth the surface area versus getting the
actually-specified invariants (inventory, coupons, idempotency) more deeply
right and tested.

**Consequences:** There is no way to model "order placed but payment
declined" — every order in this system is, definitionally, paid. If real
payment integration were added later, the natural seam is inside
`checkout.service.ts`, between inventory decrement and order-row insertion:
a synchronous "authorize" call inside the same transaction (fail → rollback
exactly as any other validation failure does today) or, for a genuinely
async gateway, splitting checkout into `PENDING` (inventory soft-held) and
a webhook-driven confirmation — a materially bigger change than this
timebox allows, which is why it's deferred rather than half-built.

## What I implemented vs. intentionally deferred

**Implemented:** cart CRUD with live pricing; atomic checkout with
inventory enforcement; idempotent checkout retries; order snapshots
independent of later product changes; milestone coupon generation;
single-use, race-safe coupon redemption; a coupon surviving a failed
checkout; a reconciling, side-effect-free admin report; validation errors
for invalid products/quantities.

**Deferred (and why):**
- **Auth/authorization** — explicitly out of scope per the assignment;
  `/admin/*` is the seam where it would attach.
- **Inventory reservation/holds with expiry** — see decision above; not
  required by the stated invariant, real scope on its own.
- **Coupon expiry** — no stated requirement; would be a `expires_at` column
  and one more check in `checkout.service.ts`.
- **Pagination** on `GET /products` and the report's `quantityByProduct` —
  fine at seed-data scale, would matter at real scale.
- **Payment gateway integration** — see decision above.
- **Soft-delete/versioning of products** — products are seed-only and never
  mutated by the API in this build; `order_lines` already snapshots what's
  needed regardless.
- **Structured request logging / request IDs** — would matter for a real
  deployment, not needed to demonstrate the graded invariants.
- **Rate limiting / abuse protection** on the idempotency-key store — an
  attacker could grow `idempotency_keys` unboundedly; a TTL/cleanup job
  would be needed in production.

## How this design would evolve for multiple instances / production scale

The concurrency guarantees above come from **one process holding the only
connection to one embedded database**. Both halves of that change under
real multi-instance scale:

- **Swap `node:sqlite` for a client/server database (Postgres).** The
  guarded updates already used here (`UPDATE ... WHERE <precondition>`,
  check `changes === 1`) and the unique constraints (`orders.cart_id`,
  `coupons.milestone_number`, `coupons.code`) are exactly the right
  primitives for a multi-writer database too — they don't need to change.
  What does need to change is the transaction wrapper: `BEGIN IMMEDIATE`'s
  free serializability was a single-process accident, not a database
  guarantee. Under Postgres with multiple app instances, the checkout
  transaction should run at `SERIALIZABLE` (or `REPEATABLE READ` with the
  explicit guarded updates already in place) and the service layer needs a
  retry-on-serialization-failure loop around `withTransaction`, since two
  instances really can now attempt to interleave.
- **The idempotency-key table becomes the actual concurrency backstop**
  across instances (today it's almost redundant with the single-process
  guarantee) — it already lives in the same database/transaction as the
  order, so this requires no design change, just for the guarantee to start
  mattering for a different reason.
- **Move the idempotency store's cleanup to a scheduled job** (TTL on old
  keys), since unbounded growth is a bigger problem once many instances are
  writing to it continuously.
- **Read scaling:** `GET /products`, `GET /orders/:id`, and `GET
  /admin/report` are all pure reads and would benefit from a read replica
  or cache in front of them once volume grows; none of the write paths
  (cart mutation, checkout, coupon generation/redemption) should ever be
  served from a replica.
- **Horizontal app scaling** then becomes trivial once the database itself
  is the single source of truth for the invariants (rather than the
  process): any number of stateless app instances can sit behind a load
  balancer.

## How AI was used

This service was built with AI assistance (Claude, via Claude Code) doing
the actual implementation from a written plan, with human-equivalent
review applied at each stage: the plan was reviewed and approved before any
code was written, every file was read back, `tsc --noEmit` and the full
test suite were run after each meaningful change (not just at the end), and
the manual curl walkthrough in the README was actually executed against a
running server before being written down as documented behavior — none of
the request/response examples are hypothetical.

**A concrete example of rejecting/redirecting AI output:** the initial,
default instinct for persistence was **better-sqlite3** — it's the
conventional choice for "synchronous, transactional, embedded SQLite in
Node," and is what most examples of this kind of service reach for. Before
committing to it, I checked the actual target environment (Windows, no
Docker, unconfirmed C++ build toolchain) and specifically verified whether
better-sqlite3's native addon would install without a source compile. Given
the risk of an un-reviewable, environment-dependent install failure for
whoever runs this project, I redirected to Node's built-in `node:sqlite`
instead — same synchronous/transactional properties, verified with a
throwaway script to work with zero native build step, before writing any
of the actual application code against it. This is recorded as its own
decision above (see "Persistence") rather than just silently swapped in,
specifically because it was a deviation from the first instinct.

## What I'd examine first with another two hours

1. **Serialization-failure retry loop**, written and tested against a real
   Postgres instance (via a throwaway Docker Compose file) to validate the
   "how this evolves" story above isn't just theoretical — actually port
   the repository layer behind an interface and prove the same test suite
   passes against both backends.
2. **Idempotency-key store cleanup/TTL**, since it's the one piece of
   deferred production-hardening that's cheap to actually implement now
   (a scheduled `DELETE WHERE created_at < ...`) rather than just describe.
3. **Coupon expiry**, since "a coupon must not be lost" arguably implies
   some lifecycle bound, and it's a small, well-contained addition
   (one column, one check) that I'd rather have time to test properly than
   add hastily now.
4. **Load-test the concurrency claims** at a higher fan-out (50–100
   concurrent checkouts against a single scarce item, rather than 5) to
   have more confidence in the "no interleaving within a process" argument
   at scale, and to measure how much the synchronous critical section
   serializes throughput under real contention.
