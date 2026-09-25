import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import {
  startTestServer,
  postJson,
  getJson,
  type TestServer,
} from "./helpers/testServer.ts";

describe("checkout", () => {
  let server: TestServer;

  it("starts a server", async () => {
    server = await startTestServer();
  });

  after(async () => {
    await server.close();
  });

  it("creates an order, decrements inventory, and snapshots line items", async () => {
    const before = await getJson(`${server.baseUrl}/products/2`);
    const startInventory = before.body.inventory;

    const cart = await postJson<{ id: string }>(`${server.baseUrl}/carts`, {});
    await postJson(`${server.baseUrl}/carts/${cart.body.id}/items`, {
      productId: 2,
      quantity: 3,
    });

    const checkout = await postJson(
      `${server.baseUrl}/carts/${cart.body.id}/checkout`,
      {},
      { "Idempotency-Key": `happy-${cart.body.id}` },
    );
    assert.equal(checkout.status, 201);
    assert.equal(checkout.body.subtotalCents, 3 * 8999);
    assert.equal(checkout.body.discountCents, 0);
    assert.equal(checkout.body.totalCents, 3 * 8999);
    assert.equal(checkout.body.lines.length, 1);
    assert.equal(checkout.body.lines[0].unitPriceCents, 8999);
    assert.equal(checkout.body.lines[0].quantity, 3);

    const after1 = await getJson(`${server.baseUrl}/products/2`);
    assert.equal(after1.body.inventory, startInventory - 3);

    const order = await getJson(`${server.baseUrl}/orders/${checkout.body.id}`);
    assert.equal(order.status, 200);
    assert.equal(order.body.totalCents, 3 * 8999);

    const cartAfter = await getJson(`${server.baseUrl}/carts/${cart.body.id}`);
    assert.equal(cartAfter.body.status, "CHECKED_OUT");
  });

  it("rejects checkout of an empty cart", async () => {
    const cart = await postJson<{ id: string }>(`${server.baseUrl}/carts`, {});
    const res = await postJson(
      `${server.baseUrl}/carts/${cart.body.id}/checkout`,
      {},
      { "Idempotency-Key": `empty-${cart.body.id}` },
    );
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, "CART_EMPTY");
  });

  it("404s checking out a cart that doesn't exist", async () => {
    const res = await postJson(
      `${server.baseUrl}/carts/does-not-exist/checkout`,
      {},
      { "Idempotency-Key": "missing-cart" },
    );
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, "CART_NOT_FOUND");
  });

  it("keeps orders from changing if the underlying product later changes", async () => {
    const cart = await postJson<{ id: string }>(`${server.baseUrl}/carts`, {});
    await postJson(`${server.baseUrl}/carts/${cart.body.id}/items`, {
      productId: 3,
      quantity: 1,
    });
    const checkout = await postJson(
      `${server.baseUrl}/carts/${cart.body.id}/checkout`,
      {},
      { "Idempotency-Key": `snapshot-${cart.body.id}` },
    );
    const priceAtCheckout = checkout.body.lines[0].unitPriceCents;

    // Directly mutate product price in the DB to simulate a later price
    // change, bypassing the API (there is no price-update endpoint by
    // design). The already-placed order must still reflect what the
    // customer actually paid.
    server.db
      .prepare("UPDATE products SET price_cents = price_cents + 500 WHERE id = 3")
      .run();

    const order = await getJson(`${server.baseUrl}/orders/${checkout.body.id}`);
    assert.equal(order.body.lines[0].unitPriceCents, priceAtCheckout);
  });
});
