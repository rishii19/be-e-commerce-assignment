import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { Order, OrderLine } from "../domain/types.ts";

interface OrderRow {
  id: string;
  cart_id: string;
  subtotal_cents: number;
  discount_cents: number;
  total_cents: number;
  coupon_id: string | null;
  coupon_code: string | null;
  created_at: string;
}

interface OrderLineRow {
  product_id: number;
  product_name: string;
  unit_price_cents: number;
  quantity: number;
  line_total_cents: number;
}

export interface NewOrderLine {
  productId: number;
  productName: string;
  unitPriceCents: number;
  quantity: number;
  lineTotalCents: number;
}

export interface NewOrder {
  cartId: string;
  subtotalCents: number;
  discountCents: number;
  totalCents: number;
  couponId: string | null;
  lines: NewOrderLine[];
}

function toOrderLine(row: OrderLineRow): OrderLine {
  return {
    productId: row.product_id,
    productName: row.product_name,
    unitPriceCents: row.unit_price_cents,
    quantity: row.quantity,
    lineTotalCents: row.line_total_cents,
  };
}

export function insertOrder(db: DatabaseSync, order: NewOrder): Order {
  const id = randomUUID();

  db.prepare(
    `INSERT INTO orders (id, cart_id, subtotal_cents, discount_cents, total_cents, coupon_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    order.cartId,
    order.subtotalCents,
    order.discountCents,
    order.totalCents,
    order.couponId,
  );

  const insertLine = db.prepare(
    `INSERT INTO order_lines (order_id, product_id, product_name, unit_price_cents, quantity, line_total_cents)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const line of order.lines) {
    insertLine.run(
      id,
      line.productId,
      line.productName,
      line.unitPriceCents,
      line.quantity,
      line.lineTotalCents,
    );
  }

  return findOrderById(db, id)!;
}

export function findOrderById(db: DatabaseSync, id: string): Order | undefined {
  const row = db
    .prepare(
      `SELECT o.id, o.cart_id, o.subtotal_cents, o.discount_cents, o.total_cents,
              o.coupon_id, c.code AS coupon_code, o.created_at
       FROM orders o
       LEFT JOIN coupons c ON c.id = o.coupon_id
       WHERE o.id = ?`,
    )
    .get(id) as OrderRow | undefined;
  if (!row) return undefined;

  const lineRows = db
    .prepare(
      `SELECT product_id, product_name, unit_price_cents, quantity, line_total_cents
       FROM order_lines WHERE order_id = ? ORDER BY id`,
    )
    .all(id) as unknown as OrderLineRow[];

  return {
    id: row.id,
    cartId: row.cart_id,
    subtotalCents: row.subtotal_cents,
    discountCents: row.discount_cents,
    totalCents: row.total_cents,
    couponId: row.coupon_id,
    couponCode: row.coupon_code,
    createdAt: row.created_at,
    lines: lineRows.map(toOrderLine),
  };
}

export function findOrderByCartId(db: DatabaseSync, cartId: string): Order | undefined {
  const row = db
    .prepare("SELECT id FROM orders WHERE cart_id = ?")
    .get(cartId) as { id: string } | undefined;
  return row ? findOrderById(db, row.id) : undefined;
}

export function countOrders(db: DatabaseSync): number {
  const row = db.prepare("SELECT COUNT(*) AS count FROM orders").get() as {
    count: number;
  };
  return row.count;
}
