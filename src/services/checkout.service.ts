import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { withTransaction } from "../db/connection.ts";
import * as cartsRepo from "../repositories/carts.repo.ts";
import * as productsRepo from "../repositories/products.repo.ts";
import * as ordersRepo from "../repositories/orders.repo.ts";
import * as couponsRepo from "../repositories/coupons.repo.ts";
import * as idempotencyRepo from "../repositories/idempotency.repo.ts";
import { AppError } from "../domain/errors.ts";
import { discountCents, lineTotalCents, subtotalCents, totalAfterDiscount } from "../domain/money.ts";
import type { Order } from "../domain/types.ts";

export interface CheckoutInput {
  cartId: string;
  couponCode?: string | null;
  idempotencyKey: string | undefined;
}

export interface CheckoutResult {
  statusCode: number;
  order: Order;
  replayed: boolean;
}

function hashRequest(cartId: string, couponCode: string | null): string {
  return createHash("sha256")
    .update(JSON.stringify({ cartId, couponCode }))
    .digest("hex");
}

/**
 * The entire checkout — idempotency lookup, validation, inventory
 * decrement, coupon redemption, and order creation — runs inside a single
 * synchronous `withTransaction` call. See db/connection.ts for why that is
 * sufficient, within one process, to make this section atomic and
 * serializable without explicit row locks. Any thrown AppError rolls the
 * whole thing back, so a failed checkout can never partially decrement
 * inventory or partially consume a coupon.
 */
export function checkout(db: DatabaseSync, input: CheckoutInput): CheckoutResult {
  if (!input.idempotencyKey) {
    throw new AppError(
      "IDEMPOTENCY_KEY_REQUIRED",
      "An Idempotency-Key header is required for checkout so retries are safe",
    );
  }
  const idempotencyKey = input.idempotencyKey;
  const couponCode = input.couponCode ?? null;
  const requestHash = hashRequest(input.cartId, couponCode);

  return withTransaction(db, () => {
    const existing = idempotencyRepo.findIdempotencyRecord(db, idempotencyKey);
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new AppError(
          "IDEMPOTENCY_KEY_CONFLICT",
          "This Idempotency-Key was already used with a different cart or coupon",
        );
      }
      return {
        statusCode: existing.statusCode,
        order: existing.responseBody as Order,
        replayed: true,
      };
    }

    const cart = cartsRepo.findCartById(db, input.cartId);
    if (!cart) {
      throw new AppError("CART_NOT_FOUND", `Cart ${input.cartId} does not exist`);
    }
    if (cart.status !== "OPEN") {
      const existingOrder = ordersRepo.findOrderByCartId(db, input.cartId);
      throw new AppError(
        "CART_ALREADY_CHECKED_OUT",
        `Cart ${input.cartId} has already been checked out`,
        existingOrder ? { existingOrderId: existingOrder.id } : undefined,
      );
    }

    const cartItems = cartsRepo.listCartItems(db, input.cartId);
    if (cartItems.length === 0) {
      throw new AppError("CART_EMPTY", "Cannot check out an empty cart");
    }

    const lines = cartItems.map((item) => {
      const product = productsRepo.findProductById(db, item.productId);
      if (!product) {
        throw new AppError(
          "PRODUCT_NOT_FOUND",
          `Product ${item.productId} no longer exists`,
        );
      }
      return {
        productId: product.id,
        productName: product.name,
        unitPriceCents: product.priceCents,
        quantity: item.quantity,
        lineTotalCents: lineTotalCents(product.priceCents, item.quantity),
        availableInventory: product.inventory,
      };
    });

    const shortages = lines
      .filter((line) => line.quantity > line.availableInventory)
      .map((line) => ({
        productId: line.productId,
        requested: line.quantity,
        available: line.availableInventory,
      }));
    if (shortages.length > 0) {
      throw new AppError(
        "INSUFFICIENT_INVENTORY",
        "One or more items exceed available inventory",
        { shortages },
      );
    }

    const subtotal = subtotalCents(lines);

    let couponId: string | null = null;
    let discount = 0;
    if (couponCode) {
      const coupon = couponsRepo.findCouponByCode(db, couponCode);
      if (!coupon) {
        throw new AppError("COUPON_NOT_FOUND", `Coupon "${couponCode}" does not exist`);
      }
      if (coupon.status !== "AVAILABLE") {
        throw new AppError(
          "COUPON_ALREADY_REDEEMED",
          `Coupon "${couponCode}" has already been redeemed`,
        );
      }
      couponId = coupon.id;
      discount = discountCents(subtotal, coupon.percentOff);
    }
    const total = totalAfterDiscount(subtotal, discount);

    for (const line of lines) {
      const ok = productsRepo.decrementInventory(db, line.productId, line.quantity);
      if (!ok) {
        throw new AppError(
          "INSUFFICIENT_INVENTORY",
          `Lost a race on inventory for product ${line.productId}`,
          { productId: line.productId },
        );
      }
    }

    const checkedOut = cartsRepo.markCartCheckedOut(db, input.cartId);
    if (!checkedOut) {
      throw new AppError(
        "CART_ALREADY_CHECKED_OUT",
        `Cart ${input.cartId} has already been checked out`,
      );
    }

    const order = ordersRepo.insertOrder(db, {
      cartId: input.cartId,
      subtotalCents: subtotal,
      discountCents: discount,
      totalCents: total,
      couponId,
      lines: lines.map((line) => ({
        productId: line.productId,
        productName: line.productName,
        unitPriceCents: line.unitPriceCents,
        quantity: line.quantity,
        lineTotalCents: line.lineTotalCents,
      })),
    });

    if (couponId) {
      const redeemed = couponsRepo.markCouponRedeemed(db, couponId, order.id);
      if (!redeemed) {
        throw new AppError(
          "COUPON_ALREADY_REDEEMED",
          "Lost a race redeeming this coupon",
        );
      }
    }

    idempotencyRepo.saveIdempotencyRecord(db, {
      key: idempotencyKey,
      cartId: input.cartId,
      requestHash,
      statusCode: 201,
      responseBody: order,
    });

    return { statusCode: 201, order, replayed: false };
  });
}
