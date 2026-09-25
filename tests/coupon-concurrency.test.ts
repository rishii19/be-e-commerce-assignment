import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, postJson, type TestServer } from "./helpers/testServer.ts";

async function checkoutOneUnit(
  server: TestServer,
  productId: number,
  idempotencyKey: string,
) {
  const cart = await postJson<{ id: string }>(`${server.baseUrl}/carts`, {});
  await postJson(`${server.baseUrl}/carts/${cart.body.id}/items`, {
    productId,
    quantity: 1,
  });
  return { cartId: cart.body.id, res: await postJson(
    `${server.baseUrl}/carts/${cart.body.id}/checkout`,
    {},
    { "Idempotency-Key": idempotencyKey },
  ) };
}

describe("coupon concurrency", () => {
  let server: TestServer;

  it("starts a server", async () => {
    server = await startTestServer({ couponMilestoneN: 2, couponDiscountPercent: 10 });
  });

  after(async () => {
    await server.close();
  });

  it("issues exactly one coupon when two admin generate calls race for the same milestone", async () => {
    await checkoutOneUnit(server, 1, "race-milestone-order-1");
    await checkoutOneUnit(server, 1, "race-milestone-order-2");

    const [a, b] = await Promise.all([
      postJson(`${server.baseUrl}/admin/coupons/generate`, {}),
      postJson(`${server.baseUrl}/admin/coupons/generate`, {}),
    ]);

    const succeeded = [a, b].filter((r) => r.status === 201);
    const failed = [a, b].filter((r) => r.status !== 201);
    assert.equal(succeeded.length, 1, "only one of the two racing calls should create a coupon");
    assert.equal(failed.length, 1);
    assert.equal(failed[0]!.body.error.code, "MILESTONE_NOT_ELIGIBLE");

    const count = server.db
      .prepare("SELECT COUNT(*) AS count FROM coupons WHERE milestone_number = 1")
      .get() as { count: number };
    assert.equal(count.count, 1);
  });

  it("lets only one of two concurrent checkouts redeem the same coupon code", async () => {
    await checkoutOneUnit(server, 1, "race-redeem-order-1");
    await checkoutOneUnit(server, 1, "race-redeem-order-2");
    const generated = await postJson(`${server.baseUrl}/admin/coupons/generate`, {});
    assert.equal(generated.status, 201);
    const code = generated.body.code;

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

    const [a, b] = await Promise.all([
      postJson(
        `${server.baseUrl}/carts/${cartA.body.id}/checkout`,
        { couponCode: code },
        { "Idempotency-Key": "race-redeem-a" },
      ),
      postJson(
        `${server.baseUrl}/carts/${cartB.body.id}/checkout`,
        { couponCode: code },
        { "Idempotency-Key": "race-redeem-b" },
      ),
    ]);

    const succeeded = [a, b].filter((r) => r.status === 201);
    const failed = [a, b].filter((r) => r.status !== 201);
    assert.equal(succeeded.length, 1, "only one concurrent checkout should redeem the coupon");
    assert.equal(failed.length, 1);
    assert.equal(failed[0]!.body.error.code, "COUPON_ALREADY_REDEEMED");

    const couponRow = server.db
      .prepare("SELECT status, redeemed_by_order_id FROM coupons WHERE code = ?")
      .get(code) as { status: string; redeemed_by_order_id: string };
    assert.equal(couponRow.status, "REDEEMED");
    assert.equal(couponRow.redeemed_by_order_id, succeeded[0]!.body.id);
  });
});
