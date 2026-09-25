import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { withTransaction } from "../db/connection.ts";
import * as couponsRepo from "../repositories/coupons.repo.ts";
import * as ordersRepo from "../repositories/orders.repo.ts";
import { AppError } from "../domain/errors.ts";
import type { Coupon } from "../domain/types.ts";

export interface CouponConfig {
  couponMilestoneN: number;
  couponDiscountPercent: number;
}

/**
 * Generates at most one coupon per call, for the lowest-numbered milestone
 * that has been reached (successfulOrders >= milestoneNumber * n) but has
 * no coupon yet. Milestone numbers are 1, 2, 3, ... in order, so if several
 * milestones were reached without anyone calling this, repeated calls walk
 * forward one at a time rather than bulk-issuing a batch.
 *
 * Runs inside a transaction and relies on the UNIQUE(milestone_number)
 * constraint as a defensive backstop: within this single-process,
 * single-writer service that constraint can never actually fire (see
 * db/connection.ts), but it documents the invariant and would keep holding
 * if this were ever run against a shared multi-writer database.
 */
export function generateCouponForNextMilestone(
  db: DatabaseSync,
  config: CouponConfig,
): Coupon {
  return withTransaction(db, () => {
    const successfulOrders = ordersRepo.countOrders(db);
    const nextMilestone = couponsRepo.highestMilestoneNumber(db) + 1;
    const eligibleMilestone = Math.floor(successfulOrders / config.couponMilestoneN);

    if (nextMilestone > eligibleMilestone) {
      throw new AppError(
        "MILESTONE_NOT_ELIGIBLE",
        `No new milestone has been reached yet (need ${nextMilestone * config.couponMilestoneN} successful orders, have ${successfulOrders})`,
        { successfulOrders, milestoneEvery: config.couponMilestoneN, nextMilestone },
      );
    }

    const code = `MILESTONE-${nextMilestone}-${randomUUID().slice(0, 8).toUpperCase()}`;
    return couponsRepo.insertCoupon(db, {
      milestoneNumber: nextMilestone,
      percentOff: config.couponDiscountPercent,
      code,
    });
  });
}
