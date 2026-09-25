import type { DatabaseSync } from "node:sqlite";
import { countOrders } from "./orders.repo.ts";
import { countCouponsByStatus } from "./coupons.repo.ts";
import type { AdminReport } from "../domain/types.ts";

interface QuantityRow {
  product_id: number;
  product_name: string;
  quantity: number;
}

interface RevenueRow {
  gross: number | null;
  discount: number | null;
  net: number | null;
}

/**
 * Every number here is derived with read-only SQL over orders / order_lines
 * / coupons at call time — there is no separate running-total table to
 * drift out of sync, so repeated calls can never mutate state and always
 * reconcile with the underlying rows.
 */
export function buildReport(db: DatabaseSync): AdminReport {
  const quantityRows = db
    .prepare(
      `SELECT product_id, product_name, SUM(quantity) AS quantity
       FROM order_lines
       GROUP BY product_id, product_name
       ORDER BY product_id`,
    )
    .all() as unknown as QuantityRow[];

  const revenueRow = db
    .prepare(
      `SELECT
         COALESCE(SUM(subtotal_cents), 0) AS gross,
         COALESCE(SUM(discount_cents), 0) AS discount,
         COALESCE(SUM(total_cents), 0) AS net
       FROM orders`,
    )
    .get() as unknown as RevenueRow;

  const coupons = countCouponsByStatus(db);

  return {
    totalOrders: countOrders(db),
    quantityByProduct: quantityRows.map((row) => ({
      productId: row.product_id,
      productName: row.product_name,
      quantity: row.quantity,
    })),
    grossRevenueCents: revenueRow.gross ?? 0,
    totalDiscountCents: revenueRow.discount ?? 0,
    netRevenueCents: revenueRow.net ?? 0,
    coupons,
  };
}
