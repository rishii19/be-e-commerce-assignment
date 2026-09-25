import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, postJson, type TestServer } from "./helpers/testServer.ts";

async function checkoutOneUnit(
  server: TestServer,
  productId: number,
  opts: { couponCode?: string; idempotencyKey: string },
) {
  const cart = await postJson<{ id: string }>(`${server.baseUrl}/carts`, {});
  await postJson(`${server.baseUrl}/carts/${cart.body.id}/items`, {
    productId,
    quantity: 1,
  });
  return postJson(
    `${server.baseUrl}/carts/${cart.body.id}/checkout`,
    { couponCode: opts.couponCode },
    { "Idempotency-Key": opts.idempotencyKey },
  );
}

describe("coupons", () => {
  // Milestone every 2 orders, 10% off, so tests don't need to place 5+ orders.
  let server: TestServer;

  it("starts a server", async () => {
    server = await startTestServer({ couponMilestoneN: 2, couponDiscountPercent: 10 });
  });

  after(async () => {
    await server.close();
  });

  it("refuses to generate a coupon before the milestone is reached", async () => {
    const res = await postJson(`${server.baseUrl}/admin/coupons/generate`, {});
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, "MILESTONE_NOT_ELIGIBLE");
  });

  it("generates exactly one coupon once the milestone is reached, then blocks until the next one", async () => {
    await checkoutOneUnit(server, 1, { idempotencyKey: "milestone-order-1" });
    await checkoutOneUnit(server, 1, { idempotencyKey: "milestone-order-2" });

    const generated = await postJson(`${server.baseUrl}/admin/coupons/generate`, {});
    assert.equal(generated.status, 201);
    assert.equal(generated.body.milestoneNumber, 1);
    assert.equal(generated.body.percentOff, 10);
    assert.equal(generated.body.status, "AVAILABLE");

    const tooSoon = await postJson(`${server.baseUrl}/admin/coupons/generate`, {});
    assert.equal(tooSoon.status, 409);
    assert.equal(tooSoon.body.error.code, "MILESTONE_NOT_ELIGIBLE");
  });

  it("applies a deterministic, floor-rounded discount and redeems the coupon", async () => {
    await checkoutOneUnit(server, 1, { idempotencyKey: "milestone-order-3" });
    await checkoutOneUnit(server, 1, { idempotencyKey: "milestone-order-4" });
    const generated = await postJson(`${server.baseUrl}/admin/coupons/generate`, {});
    assert.equal(generated.status, 201);
    const code = generated.body.code;

    // product 1 costs 2499 cents; 10% of 2499 is 249.9, which must floor to 249.
    const result = await checkoutOneUnit(server, 1, {
      couponCode: code,
      idempotencyKey: "redeem-coupon-1",
    });
    assert.equal(result.status, 201);
    assert.equal(result.body.subtotalCents, 2499);
    assert.equal(result.body.discountCents, 249);
    assert.equal(result.body.totalCents, 2250);

    const reuse = await checkoutOneUnit(server, 1, {
      couponCode: code,
      idempotencyKey: "redeem-coupon-2",
    });
    assert.equal(reuse.status, 409);
    assert.equal(reuse.body.error.code, "COUPON_ALREADY_REDEEMED");
  });

  it("does not consume a coupon when checkout ultimately fails", async () => {
    await checkoutOneUnit(server, 1, { idempotencyKey: "milestone-order-5" });
    await checkoutOneUnit(server, 1, { idempotencyKey: "milestone-order-6" });
    const generated = await postJson(`${server.baseUrl}/admin/coupons/generate`, {});
    assert.equal(generated.status, 201);
    const code = generated.body.code;

    const cart = await postJson<{ id: string }>(`${server.baseUrl}/carts`, {});
    // Cart is left empty on purpose so checkout fails with CART_EMPTY.
    const failed = await postJson(
      `${server.baseUrl}/carts/${cart.body.id}/checkout`,
      { couponCode: code },
      { "Idempotency-Key": "failed-checkout-with-coupon" },
    );
    assert.equal(failed.status, 400);
    assert.equal(failed.body.error.code, "CART_EMPTY");

    const couponRow = server.db
      .prepare("SELECT status FROM coupons WHERE code = ?")
      .get(code) as { status: string };
    assert.equal(couponRow.status, "AVAILABLE");
  });

  it("rejects an unknown coupon code", async () => {
    const res = await checkoutOneUnit(server, 1, {
      couponCode: "NOT-A-REAL-CODE",
      idempotencyKey: "unknown-coupon",
    });
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, "COUPON_NOT_FOUND");
  });
});
