import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createDatabase, withTransaction } from "../src/db/connection.ts";
import { seedIfEmpty } from "../src/db/seed.ts";
import * as cartsRepo from "../src/repositories/carts.repo.ts";
import * as productsRepo from "../src/repositories/products.repo.ts";
import * as ordersRepo from "../src/repositories/orders.repo.ts";
import * as couponsRepo from "../src/repositories/coupons.repo.ts";

/**
 * Reproduces, at the repository level, the exact sequence checkout.service.ts
 * runs inside its single withTransaction call — decrement inventory, flip the
 * cart to CHECKED_OUT, insert the order, then redeem the coupon — and forces
 * a failure immediately after the coupon redemption succeeds (in place of
 * where saveIdempotencyRecord runs next in the real flow). This is the one
 * step of checkout that happens *after* the coupon is marked redeemed, so a
 * throw there is the only way, given the real code's statement order, to put
 * "coupon redeemed" and "order not yet committed" in the same window.
 */
describe("checkout atomicity", () => {
  it("rolls back inventory, the order, and the cart status if something fails after the coupon is marked redeemed but before commit", () => {
    const db = createDatabase(":memory:");
    seedIfEmpty(db);

    const product = productsRepo.findProductById(db, 1)!;
    const cart = cartsRepo.createCart(db);
    cartsRepo.upsertCartItem(db, cart.id, product.id, 1);
    const coupon = couponsRepo.insertCoupon(db, {
      milestoneNumber: 1,
      percentOff: 10,
      code: "ATOMICITY-TEST",
    });

    assert.throws(
      () => {
        withTransaction(db, () => {
          const decremented = productsRepo.decrementInventory(db, product.id, 1);
          assert.equal(decremented, true);

          const checkedOut = cartsRepo.markCartCheckedOut(db, cart.id);
          assert.equal(checkedOut, true);

          const order = ordersRepo.insertOrder(db, {
            cartId: cart.id,
            subtotalCents: product.priceCents,
            discountCents: 0,
            totalCents: product.priceCents,
            couponId: coupon.id,
            lines: [
              {
                productId: product.id,
                productName: product.name,
                unitPriceCents: product.priceCents,
                quantity: 1,
                lineTotalCents: product.priceCents,
              },
            ],
          });

          const redeemed = couponsRepo.markCouponRedeemed(db, coupon.id, order.id);
          assert.equal(redeemed, true, "coupon must be flipped to REDEEMED before the forced failure");

          // Stand-in for the real next statement (saveIdempotencyRecord)
          // failing, e.g. on a UNIQUE violation — the transaction is not
          // committed yet, so nothing after this point has taken effect.
          throw new Error("forced failure after coupon redemption, before commit");
        });
      },
      /forced failure after coupon redemption/,
    );

    const couponAfter = couponsRepo.findCouponById(db, coupon.id)!;
    assert.equal(
      couponAfter.status,
      "AVAILABLE",
      "a failure before commit must roll the coupon redemption back too — it can never be left REDEEMED with no matching order",
    );
    assert.equal(couponAfter.redeemedByOrderId, null);

    const productAfter = productsRepo.findProductById(db, product.id)!;
    assert.equal(productAfter.inventory, product.inventory, "inventory decrement must roll back");

    const cartAfter = cartsRepo.findCartById(db, cart.id)!;
    assert.equal(cartAfter.status, "OPEN", "cart must remain OPEN so the customer can retry");

    const orderAfter = ordersRepo.findOrderByCartId(db, cart.id);
    assert.equal(orderAfter, undefined, "no order row may exist for a rolled-back checkout");
  });
});
