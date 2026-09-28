import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, postJson, getJson, type TestServer } from "./helpers/testServer.ts";

describe("checkout idempotency", () => {
  let server: TestServer;

  it("starts a server", async () => {
    server = await startTestServer();
  });

  after(async () => {
    await server.close();
  });

  it("requires an Idempotency-Key header", async () => {
    const cart = await postJson<{ id: string }>(`${server.baseUrl}/carts`, {});
    await postJson(`${server.baseUrl}/carts/${cart.body.id}/items`, {
      productId: 1,
      quantity: 1,
    });
    const res = await postJson(`${server.baseUrl}/carts/${cart.body.id}/checkout`, {});
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, "IDEMPOTENCY_KEY_REQUIRED");
  });

  it("replays the same response and does not double-charge inventory on retry", async () => {
    const before = await getJson(`${server.baseUrl}/products/1`);

    const cart = await postJson<{ id: string }>(`${server.baseUrl}/carts`, {});
    await postJson(`${server.baseUrl}/carts/${cart.body.id}/items`, {
      productId: 1,
      quantity: 2,
    });

    const key = `retry-key-${cart.body.id}`;
    const first = await postJson(
      `${server.baseUrl}/carts/${cart.body.id}/checkout`,
      {},
      { "Idempotency-Key": key },
    );
    assert.equal(first.status, 201);

    // Fire several sequential retries with the exact same key, as a client
    // would after a timeout with no response.
    for (let i = 0; i < 3; i++) {
      const retry = await postJson(
        `${server.baseUrl}/carts/${cart.body.id}/checkout`,
        {},
        { "Idempotency-Key": key },
      );
      assert.equal(retry.status, 201);
      assert.equal(retry.body.id, first.body.id);
    }

    const after1 = await getJson(`${server.baseUrl}/products/1`);
    assert.equal(after1.body.inventory, before.body.inventory - 2);

    const orderCount = server.db
      .prepare("SELECT COUNT(*) AS count FROM orders WHERE cart_id = ?")
      .get(cart.body.id) as { count: number };
    assert.equal(orderCount.count, 1);
  });

  it("rejects reusing a key with a different cart/coupon as a conflict", async () => {
    const cartA = await postJson<{ id: string }>(`${server.baseUrl}/carts`, {});
    await postJson(`${server.baseUrl}/carts/${cartA.body.id}/items`, {
      productId: 1,
      quantity: 1,
    });
    const cartB = await postJson<{ id: string }>(`${server.baseUrl}/carts`, {});
    await postJson(`${server.baseUrl}/carts/${cartB.body.id}/items`, {
      productId: 1,
      quantity: 1,
    });

    const sharedKey = "reused-key";
    const first = await postJson(
      `${server.baseUrl}/carts/${cartA.body.id}/checkout`,
      {},
      { "Idempotency-Key": sharedKey },
    );
    assert.equal(first.status, 201);

    const second = await postJson(
      `${server.baseUrl}/carts/${cartB.body.id}/checkout`,
      {},
      { "Idempotency-Key": sharedKey },
    );
    assert.equal(second.status, 422);
    assert.equal(second.body.error.code, "IDEMPOTENCY_KEY_CONFLICT");
  });

  it("returns 409 CART_ALREADY_CHECKED_OUT with the prior order id when the same cart is checked out again with a DIFFERENT key", async () => {
    const cart = await postJson<{ id: string }>(`${server.baseUrl}/carts`, {});
    await postJson(`${server.baseUrl}/carts/${cart.body.id}/items`, {
      productId: 1,
      quantity: 1,
    });

    const first = await postJson(
      `${server.baseUrl}/carts/${cart.body.id}/checkout`,
      {},
      { "Idempotency-Key": `first-${cart.body.id}` },
    );
    assert.equal(first.status, 201);

    const second = await postJson(
      `${server.baseUrl}/carts/${cart.body.id}/checkout`,
      {},
      { "Idempotency-Key": `second-${cart.body.id}` },
    );
    assert.equal(second.status, 409);
    assert.equal(second.body.error.code, "CART_ALREADY_CHECKED_OUT");
    assert.equal(second.body.error.details.existingOrderId, first.body.id);
  });

  it("returns 400 IDEMPOTENCY_KEY_REQUIRED (not 409) when the same cart is checked out again with NO key at all", async () => {
    // Documents actual behavior: the missing-header check in
    // checkout.service.ts runs unconditionally before the cart-status check,
    // so an omitted key short-circuits to IDEMPOTENCY_KEY_REQUIRED even
    // though DECISIONS.md's "Retrying checkout... with no/different
    // idempotency key" note describes both cases as producing 409.
    const cart = await postJson<{ id: string }>(`${server.baseUrl}/carts`, {});
    await postJson(`${server.baseUrl}/carts/${cart.body.id}/items`, {
      productId: 1,
      quantity: 1,
    });

    const first = await postJson(
      `${server.baseUrl}/carts/${cart.body.id}/checkout`,
      {},
      { "Idempotency-Key": `first-no-key-${cart.body.id}` },
    );
    assert.equal(first.status, 201);

    const second = await postJson(`${server.baseUrl}/carts/${cart.body.id}/checkout`, {});
    assert.equal(second.status, 400);
    assert.equal(second.body.error.code, "IDEMPOTENCY_KEY_REQUIRED");
  });

  it("fires concurrent retries of the same checkout and still produces exactly one order", async () => {
    const cart = await postJson<{ id: string }>(`${server.baseUrl}/carts`, {});
    await postJson(`${server.baseUrl}/carts/${cart.body.id}/items`, {
      productId: 3,
      quantity: 1,
    });

    const key = `concurrent-retry-${cart.body.id}`;
    const attempts = Array.from({ length: 5 }, () =>
      postJson(
        `${server.baseUrl}/carts/${cart.body.id}/checkout`,
        {},
        { "Idempotency-Key": key },
      ),
    );
    const results = await Promise.all(attempts);

    for (const res of results) {
      assert.equal(res.status, 201);
    }
    const orderIds = new Set(results.map((r) => r.body.id));
    assert.equal(orderIds.size, 1, "all concurrent retries must return the same order");

    const orderCount = server.db
      .prepare("SELECT COUNT(*) AS count FROM orders WHERE cart_id = ?")
      .get(cart.body.id) as { count: number };
    assert.equal(orderCount.count, 1);
  });
});
