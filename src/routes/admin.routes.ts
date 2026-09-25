import { Router } from "express";
import type { DatabaseSync } from "node:sqlite";
import * as couponService from "../services/coupon.service.ts";
import * as reportService from "../services/report.service.ts";
import type { CouponConfig } from "../services/coupon.service.ts";

/**
 * Everything under this router is treated as an administrator-only
 * operation. No auth is implemented per the assignment scope, but these
 * are the endpoints a real deployment would put behind an admin role.
 */
export function createAdminRouter(db: DatabaseSync, config: CouponConfig): Router {
  const router = Router();

  router.post("/coupons/generate", (_req, res) => {
    const coupon = couponService.generateCouponForNextMilestone(db, config);
    res.status(201).json(coupon);
  });

  router.get("/report", (_req, res) => {
    res.json(reportService.getReport(db));
  });

  return router;
}
