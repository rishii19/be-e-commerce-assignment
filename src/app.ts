import express, { type Express } from "express";
import type { DatabaseSync } from "node:sqlite";
import { createProductsRouter } from "./routes/products.routes.ts";
import { createCartsRouter } from "./routes/carts.routes.ts";
import { createOrdersRouter } from "./routes/orders.routes.ts";
import { createAdminRouter } from "./routes/admin.routes.ts";
import { notFoundHandler, errorHandler } from "./middleware/errorHandler.ts";
import type { CouponConfig } from "./services/coupon.service.ts";

export function createApp(db: DatabaseSync, config: CouponConfig): Express {
  const app = express();
  app.use(express.json());

  app.use("/products", createProductsRouter(db));
  app.use("/carts", createCartsRouter(db));
  app.use("/orders", createOrdersRouter(db));
  app.use("/admin", createAdminRouter(db, config));

  app.get("/health", (_req, res) => res.json({ status: "ok" }));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
