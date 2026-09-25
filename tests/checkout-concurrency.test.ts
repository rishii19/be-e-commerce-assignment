import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, postJson, getJson, type TestServer } from "./helpers/testServer.ts";

const SCARCE_PRODUCT_ID = 5; // seeded with inventory = 2

describe("checkout concurrency", () => {
  let server: TestServer;

  it("starts a server", async () => {
    server = await startTestServer();
  });

  after(async () => {
    await server.close();
  });

  it("never oversells a limited-inventory product under concurrent checkouts", async () => {
    const before = await getJson(`${server.baseUrl}/products/${SCARCE_PRODUCT_ID}`);
    assert.equal(before.body.inventory, 2);

    const cartIds = await Promise.all(
      Array.from({ length: 5 }, async () => {
        const cart = await postJson<{ id: string }>(`${server.baseUrl}/carts`, {});
        await postJson(`${server.baseUrl}/carts/${cart.body.id}/items`, {
          productId: SCARCE_PRODUCT_ID,
          quantity: 1,
        });
        return cart.body.id;
      }),
    );

    const results = await Promise.all(
      cartIds.map((cartId) =>
        postJson(
          `${server.baseUrl}/carts/${cartId}/checkout`,
          {},
          { "Idempotency-Key": `oversell-${cartId}` },
        ),
      ),
    );

    const succeeded = results.filter((r) => r.status === 201);
    const failed = results.filter((r) => r.status !== 201);

    assert.equal(succeeded.length, 2, "exactly as many checkouts as available stock should succeed");
    assert.equal(failed.length, 3);
    for (const res of failed) {
      assert.equal(res.body.error.code, "INSUFFICIENT_INVENTORY");
    }

    const after1 = await getJson(`${server.baseUrl}/products/${SCARCE_PRODUCT_ID}`);
    assert.equal(after1.body.inventory, 0, "inventory must never go negative or under-decrement");
  });
});
