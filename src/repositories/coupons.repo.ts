import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { Coupon } from "../domain/types.ts";

interface CouponRow {
  id: string;
  code: string;
  milestone_number: number;
  percent_off: number;
  status: "AVAILABLE" | "REDEEMED";
  redeemed_by_order_id: string | null;
  created_at: string;
  redeemed_at: string | null;
}

function toCoupon(row: CouponRow): Coupon {
  return {
    id: row.id,
    code: row.code,
    milestoneNumber: row.milestone_number,
    percentOff: row.percent_off,
    status: row.status,
    redeemedByOrderId: row.redeemed_by_order_id,
    createdAt: row.created_at,
    redeemedAt: row.redeemed_at,
  };
}

export function highestMilestoneNumber(db: DatabaseSync): number {
  const row = db
    .prepare("SELECT COALESCE(MAX(milestone_number), 0) AS max FROM coupons")
    .get() as { max: number };
  return row.max;
}

export function insertCoupon(
  db: DatabaseSync,
  params: { milestoneNumber: number; percentOff: number; code: string },
): Coupon {
  const id = randomUUID();
  db.prepare(
    "INSERT INTO coupons (id, code, milestone_number, percent_off) VALUES (?, ?, ?, ?)",
  ).run(id, params.code, params.milestoneNumber, params.percentOff);
  return findCouponById(db, id)!;
}

export function findCouponById(db: DatabaseSync, id: string): Coupon | undefined {
  const row = db.prepare("SELECT * FROM coupons WHERE id = ?").get(id) as
    | CouponRow
    | undefined;
  return row ? toCoupon(row) : undefined;
}

export function findCouponByCode(db: DatabaseSync, code: string): Coupon | undefined {
  const row = db.prepare("SELECT * FROM coupons WHERE code = ?").get(code) as
    | CouponRow
    | undefined;
  return row ? toCoupon(row) : undefined;
}

/**
 * Flips AVAILABLE -> REDEEMED only if it is still AVAILABLE. Returns false
 * if another checkout already redeemed it (or it doesn't exist), which is
 * how the checkout service detects a lost race on a coupon code.
 */
export function markCouponRedeemed(
  db: DatabaseSync,
  couponId: string,
  orderId: string,
): boolean {
  const result = db
    .prepare(
      `UPDATE coupons
       SET status = 'REDEEMED', redeemed_by_order_id = ?, redeemed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? AND status = 'AVAILABLE'`,
    )
    .run(orderId, couponId);
  return result.changes === 1;
}

export function countCouponsByStatus(
  db: DatabaseSync,
): { generated: number; available: number; redeemed: number } {
  const row = db
    .prepare(
      `SELECT
         COUNT(*) AS generated,
         SUM(CASE WHEN status = 'AVAILABLE' THEN 1 ELSE 0 END) AS available,
         SUM(CASE WHEN status = 'REDEEMED' THEN 1 ELSE 0 END) AS redeemed
       FROM coupons`,
    )
    .get() as { generated: number; available: number | null; redeemed: number | null };
  return {
    generated: row.generated,
    available: row.available ?? 0,
    redeemed: row.redeemed ?? 0,
  };
}
