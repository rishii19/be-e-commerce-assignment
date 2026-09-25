import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, postJson, getJson, type TestServer } from "./helpers/testServer.ts";

async function checkout(
  server: TestServer,
  productId: number,
  quantity: number,
  idempotencyKey: string,
  couponCode?: string,
) {
  const cart = await postJson<{ id: string }>(`${server.baseUrl}/carts`, {});
  await postJson(`${server.baseUrl}/carts/${cart.body.id}/items`, { productId, quantity });
  return postJson(
    `${server.baseUrl}/carts/${cart.body.id}/checkout`,
    { couponCode },
    { "Idempotency-Key": idempotencyKey },
  );
}

describe("admin report", () => {
  let server: TestServer;

  it("starts a server", async () => {
    server = await startTestServer({ couponMilestoneN: 2, couponDiscountPercent: 10 });
  });

  after(async () => {
    await server.close();
  });

  it("reconciles with the orders and coupons actually created, and is stable across repeats", async () => {
    const order1 = await checkout(server, 1, 2, "report-order-1"); // 2 x 2499 = 4998
    const order2 = await checkout(server, 1, 2, "report-order-2"); // 2 x 2499 = 4998, hits milestone 1

    const coupon = await postJson(`${server.baseUrl}/admin/coupons/generate`, {});
    assert.equal(coupon.status, 201);

    const order3 = await checkout(server, 2, 1, "report-order-3", coupon.body.code); // 8999, 10% off

    for (const res of [order1, order2, order3]) {
      assert.equal(res.status, 201);
    }

    const expectedGross = 4998 + 4998 + 8999;
    const expectedDiscount = 899; // floor(8999 * 10 / 100)
    const expectedNet = expectedGross - expectedDiscount;

    const report1 = await getJson(`${server.baseUrl}/admin/report`);
    assert.equal(report1.status, 200);
    assert.equal(report1.body.totalOrders, 3);
    assert.equal(report1.body.grossRevenueCents, expectedGross);
    assert.equal(report1.body.totalDiscountCents, expectedDiscount);
    assert.equal(report1.body.netRevenueCents, expectedNet);
    assert.equal(report1.body.coupons.generated, 1);
    assert.equal(report1.body.coupons.available, 0);
    assert.equal(report1.body.coupons.redeemed, 1);

    const product1Line = report1.body.quantityByProduct.find(
      (line: { productId: number }) => line.productId === 1,
    );
    const product2Line = report1.body.quantityByProduct.find(
      (line: { productId: number }) => line.productId === 2,
    );
    assert.equal(product1Line.quantity, 4);
    assert.equal(product2Line.quantity, 1);

    // Repeated report calls are pure reads: identical result, no side effects.
    const report2 = await getJson(`${server.baseUrl}/admin/report`);
    assert.deepEqual(report2.body, report1.body);
  });
});
