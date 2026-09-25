import { Router } from "express";
import type { DatabaseSync } from "node:sqlite";
import * as ordersRepo from "../repositories/orders.repo.ts";
import { AppError } from "../domain/errors.ts";

export function createOrdersRouter(db: DatabaseSync): Router {
  const router = Router();

  router.get("/:orderId", (req, res) => {
    const order = ordersRepo.findOrderById(db, req.params.orderId);
    if (!order) {
      throw new AppError("ORDER_NOT_FOUND", `Order ${req.params.orderId} does not exist`);
    }
    res.json(order);
  });

  return router;
}
