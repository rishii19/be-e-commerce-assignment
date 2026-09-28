import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import {
  startTestServer,
  postJson,
  patchJson,
  getJson,
  deleteJson,
  type TestServer,
} from "./helpers/testServer.ts";

describe("carts", () => {
  let server: TestServer;

  it("starts a server", async () => {
    server = await startTestServer();
  });

  after(async () => {
    await server.close();
  });

  it("creates an empty cart with a zero subtotal", async () => {
    const res = await postJson(`${server.baseUrl}/carts`, {});
    assert.equal(res.status, 201);
    assert.equal(res.body.status, "OPEN");
    assert.deepEqual(res.body.items, []);
    assert.equal(res.body.subtotalCents, 0);
  });

  it("rejects an unknown product id", async () => {
    const cart = await postJson<{ id: string }>(`${server.baseUrl}/carts`, {});
    const res = await postJson(`${server.baseUrl}/carts/${cart.body.id}/items`, {
      productId: 999_999,
      quantity: 1,
    });
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, "PRODUCT_NOT_FOUND");
  });

  it("rejects non-positive or non-integer quantities", async () => {
    const cart = await postJson<{ id: string }>(`${server.baseUrl}/carts`, {});
    for (const quantity of [0, -1, 1.5, "two", null]) {
      const res = await postJson(`${server.baseUrl}/carts/${cart.body.id}/items`, {
        productId: 1,
        quantity,
      });
      assert.equal(res.status, 400, `quantity ${JSON.stringify(quantity)} should be rejected`);
      assert.equal(res.body.error.code, "VALIDATION_ERROR");
    }
  });

  it("rejects non-positive or non-integer quantities on PATCH (update quantity)", async () => {
    const cart = await postJson<{ id: string }>(`${server.baseUrl}/carts`, {});
    await postJson(`${server.baseUrl}/carts/${cart.body.id}/items`, {
      productId: 2,
      quantity: 1,
    });
    for (const quantity of [0, -1, 1.5, "two", null]) {
      const res = await patchJson(`${server.baseUrl}/carts/${cart.body.id}/items/2`, {
        quantity,
      });
      assert.equal(res.status, 400, `quantity ${JSON.stringify(quantity)} should be rejected`);
      assert.equal(res.body.error.code, "VALIDATION_ERROR");
    }
  });

  it("computes integer-cent line totals and accumulates repeated adds", async () => {
    const cart = await postJson<{ id: string }>(`${server.baseUrl}/carts`, {});
    await postJson(`${server.baseUrl}/carts/${cart.body.id}/items`, {
      productId: 1,
      quantity: 2,
    });
    const res = await postJson(`${server.baseUrl}/carts/${cart.body.id}/items`, {
      productId: 1,
      quantity: 3,
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.items.length, 1);
    assert.equal(res.body.items[0].quantity, 5);
    assert.equal(res.body.items[0].lineTotalCents, 5 * 2499);
    assert.equal(res.body.subtotalCents, 5 * 2499);
  });

  it("rejects a quantity that exceeds available inventory", async () => {
    const cart = await postJson<{ id: string }>(`${server.baseUrl}/carts`, {});
    // product 5 is seeded with inventory = 2
    const res = await postJson(`${server.baseUrl}/carts/${cart.body.id}/items`, {
      productId: 5,
      quantity: 3,
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, "INSUFFICIENT_INVENTORY");
  });

  it("updates and removes items, 404s on items that don't exist", async () => {
    const cart = await postJson<{ id: string }>(`${server.baseUrl}/carts`, {});
    await postJson(`${server.baseUrl}/carts/${cart.body.id}/items`, {
      productId: 2,
      quantity: 1,
    });

    const patched = await patchJson(
      `${server.baseUrl}/carts/${cart.body.id}/items/2`,
      { quantity: 4 },
    );
    assert.equal(patched.status, 200);
    assert.equal(patched.body.items[0].quantity, 4);

    const missingPatch = await patchJson(
      `${server.baseUrl}/carts/${cart.body.id}/items/999`,
      { quantity: 1 },
    );
    assert.equal(missingPatch.status, 404);
    assert.equal(missingPatch.body.error.code, "CART_ITEM_NOT_FOUND");

    const removed = await deleteJson(`${server.baseUrl}/carts/${cart.body.id}/items/2`);
    assert.equal(removed.status, 200);
    assert.deepEqual(removed.body.items, []);

    const missingDelete = await deleteJson(
      `${server.baseUrl}/carts/${cart.body.id}/items/2`,
    );
    assert.equal(missingDelete.status, 404);
  });

  it("404s when viewing a cart that doesn't exist", async () => {
    const res = await getJson(`${server.baseUrl}/carts/does-not-exist`);
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, "CART_NOT_FOUND");
  });

  it("refuses to modify a cart that has already been checked out", async () => {
    const cart = await postJson<{ id: string }>(`${server.baseUrl}/carts`, {});
    await postJson(`${server.baseUrl}/carts/${cart.body.id}/items`, {
      productId: 1,
      quantity: 1,
    });
    const checkout = await postJson(
      `${server.baseUrl}/carts/${cart.body.id}/checkout`,
      {},
      { "Idempotency-Key": `cart-lock-${cart.body.id}` },
    );
    assert.equal(checkout.status, 201);

    const addAfter = await postJson(`${server.baseUrl}/carts/${cart.body.id}/items`, {
      productId: 2,
      quantity: 1,
    });
    assert.equal(addAfter.status, 409);
    assert.equal(addAfter.body.error.code, "CART_ALREADY_CHECKED_OUT");
  });
});
