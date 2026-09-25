import type { DatabaseSync } from "node:sqlite";
import * as cartsRepo from "../repositories/carts.repo.ts";
import * as productsRepo from "../repositories/products.repo.ts";
import { AppError } from "../domain/errors.ts";
import { lineTotalCents, subtotalCents } from "../domain/money.ts";
import type { Cart, CartView } from "../domain/types.ts";

function requireOpenCart(db: DatabaseSync, cartId: string): Cart {
  const cart = cartsRepo.findCartById(db, cartId);
  if (!cart) {
    throw new AppError("CART_NOT_FOUND", `Cart ${cartId} does not exist`);
  }
  if (cart.status !== "OPEN") {
    throw new AppError(
      "CART_ALREADY_CHECKED_OUT",
      `Cart ${cartId} has already been checked out and can no longer be modified`,
    );
  }
  return cart;
}

function validateQuantity(quantity: unknown): number {
  if (typeof quantity !== "number" || !Number.isInteger(quantity) || quantity < 1) {
    throw new AppError(
      "VALIDATION_ERROR",
      "quantity must be a positive integer",
      { quantity },
    );
  }
  return quantity;
}

export function createCart(db: DatabaseSync): Cart {
  return cartsRepo.createCart(db);
}

/**
 * Cart views always reflect *current* product price and inventory (see
 * DECISIONS.md: live pricing, snapshotted only at checkout), so a client
 * never checks out against stale numbers they haven't just seen.
 */
export function viewCart(db: DatabaseSync, cartId: string): CartView {
  const cart = cartsRepo.findCartById(db, cartId);
  if (!cart) {
    throw new AppError("CART_NOT_FOUND", `Cart ${cartId} does not exist`);
  }

  const itemRows = cartsRepo.listCartItems(db, cartId);
  const items = itemRows.map((row) => {
    const product = productsRepo.findProductById(db, row.productId);
    const unitPriceCents = product?.priceCents ?? 0;
    return {
      productId: row.productId,
      productName: product?.name ?? "(product no longer available)",
      quantity: row.quantity,
      unitPriceCents,
      availableInventory: product?.inventory ?? 0,
      lineTotalCents: lineTotalCents(unitPriceCents, row.quantity),
    };
  });

  return {
    id: cart.id,
    status: cart.status,
    createdAt: cart.createdAt,
    items,
    subtotalCents: subtotalCents(items),
  };
}

export function addItem(
  db: DatabaseSync,
  cartId: string,
  productId: unknown,
  quantity: unknown,
): CartView {
  requireOpenCart(db, cartId);
  const qty = validateQuantity(quantity);

  if (typeof productId !== "number" || !Number.isInteger(productId)) {
    throw new AppError("VALIDATION_ERROR", "productId must be an integer", {
      productId,
    });
  }
  const product = productsRepo.findProductById(db, productId);
  if (!product) {
    throw new AppError("PRODUCT_NOT_FOUND", `Product ${productId} does not exist`);
  }

  const existing = cartsRepo
    .listCartItems(db, cartId)
    .find((item) => item.productId === productId);
  const newQuantity = (existing?.quantity ?? 0) + qty;

  // Advisory check: catches the common case up front for a better error
  // message. It is not a reservation — availability is re-checked and
  // enforced atomically again at checkout, which is the actual invariant
  // guard (see DECISIONS.md).
  if (newQuantity > product.inventory) {
    throw new AppError(
      "INSUFFICIENT_INVENTORY",
      `Only ${product.inventory} unit(s) of "${product.name}" are available`,
      { productId, requested: newQuantity, available: product.inventory },
    );
  }

  cartsRepo.upsertCartItem(db, cartId, productId, newQuantity);
  return viewCart(db, cartId);
}

export function updateItemQuantity(
  db: DatabaseSync,
  cartId: string,
  productId: number,
  quantity: unknown,
): CartView {
  requireOpenCart(db, cartId);
  const qty = validateQuantity(quantity);

  const product = productsRepo.findProductById(db, productId);
  if (product && qty > product.inventory) {
    throw new AppError(
      "INSUFFICIENT_INVENTORY",
      `Only ${product.inventory} unit(s) of "${product.name}" are available`,
      { productId, requested: qty, available: product.inventory },
    );
  }

  const changed = cartsRepo.setCartItemQuantity(db, cartId, productId, qty);
  if (!changed) {
    throw new AppError(
      "CART_ITEM_NOT_FOUND",
      `Product ${productId} is not in cart ${cartId}`,
    );
  }
  return viewCart(db, cartId);
}

export function removeItem(db: DatabaseSync, cartId: string, productId: number): CartView {
  requireOpenCart(db, cartId);
  const changed = cartsRepo.removeCartItem(db, cartId, productId);
  if (!changed) {
    throw new AppError(
      "CART_ITEM_NOT_FOUND",
      `Product ${productId} is not in cart ${cartId}`,
    );
  }
  return viewCart(db, cartId);
}
