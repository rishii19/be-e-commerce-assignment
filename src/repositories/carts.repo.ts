import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { Cart, CartItemRow, CartStatus } from "../domain/types.ts";

interface CartRow {
  id: string;
  status: CartStatus;
  created_at: string;
}

interface CartItemDbRow {
  cart_id: string;
  product_id: number;
  quantity: number;
}

function toCart(row: CartRow): Cart {
  return { id: row.id, status: row.status, createdAt: row.created_at };
}

export function createCart(db: DatabaseSync): Cart {
  const id = randomUUID();
  db.prepare("INSERT INTO carts (id, status) VALUES (?, 'OPEN')").run(id);
  return findCartById(db, id)!;
}

export function findCartById(db: DatabaseSync, id: string): Cart | undefined {
  const row = db
    .prepare("SELECT id, status, created_at FROM carts WHERE id = ?")
    .get(id) as CartRow | undefined;
  return row ? toCart(row) : undefined;
}

export function listCartItems(db: DatabaseSync, cartId: string): CartItemRow[] {
  const rows = db
    .prepare(
      "SELECT cart_id, product_id, quantity FROM cart_items WHERE cart_id = ? ORDER BY product_id",
    )
    .all(cartId) as unknown as CartItemDbRow[];
  return rows.map((row) => ({
    cartId: row.cart_id,
    productId: row.product_id,
    quantity: row.quantity,
  }));
}

export function upsertCartItem(
  db: DatabaseSync,
  cartId: string,
  productId: number,
  quantity: number,
): void {
  db.prepare(
    `INSERT INTO cart_items (cart_id, product_id, quantity)
     VALUES (?, ?, ?)
     ON CONFLICT (cart_id, product_id)
     DO UPDATE SET quantity = excluded.quantity`,
  ).run(cartId, productId, quantity);
}

export function setCartItemQuantity(
  db: DatabaseSync,
  cartId: string,
  productId: number,
  quantity: number,
): boolean {
  const result = db
    .prepare(
      "UPDATE cart_items SET quantity = ? WHERE cart_id = ? AND product_id = ?",
    )
    .run(quantity, cartId, productId);
  return result.changes === 1;
}

export function removeCartItem(
  db: DatabaseSync,
  cartId: string,
  productId: number,
): boolean {
  const result = db
    .prepare("DELETE FROM cart_items WHERE cart_id = ? AND product_id = ?")
    .run(cartId, productId);
  return result.changes === 1;
}

/**
 * One-way OPEN -> CHECKED_OUT transition, guarded by the WHERE clause so a
 * second concurrent/replayed attempt can never flip an already-checked-out
 * cart again. Returns false if the cart was not OPEN.
 */
export function markCartCheckedOut(db: DatabaseSync, cartId: string): boolean {
  const result = db
    .prepare("UPDATE carts SET status = 'CHECKED_OUT' WHERE id = ? AND status = 'OPEN'")
    .run(cartId);
  return result.changes === 1;
}
