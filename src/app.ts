import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Express } from "express";
import swaggerUi from "swagger-ui-express";
import YAML from "yaml";
import type { DatabaseSync } from "node:sqlite";
import { createProductsRouter } from "./routes/products.routes.ts";
import { createCartsRouter } from "./routes/carts.routes.ts";
import { createOrdersRouter } from "./routes/orders.routes.ts";
import { createAdminRouter } from "./routes/admin.routes.ts";
import { notFoundHandler, errorHandler } from "./middleware/errorHandler.ts";
import type { CouponConfig } from "./services/coupon.service.ts";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const OPENAPI_PATH = path.join(moduleDir, "..", "openapi.yaml");
const PUBLIC_DIR = path.join(moduleDir, "..", "public");

export function createApp(db: DatabaseSync, config: CouponConfig): Express {
  const app = express();
  app.use(express.json());

  app.use("/products", createProductsRouter(db));
  app.use("/carts", createCartsRouter(db));
  app.use("/orders", createOrdersRouter(db));
  app.use("/admin", createAdminRouter(db, config));

  app.get("/health", (_req, res) => res.json({ status: "ok" }));

  const openapiDocument = YAML.parse(fs.readFileSync(OPENAPI_PATH, "utf8"));
  app.use("/docs", swaggerUi.serve, swaggerUi.setup(openapiDocument));

  app.use(express.static(PUBLIC_DIR));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
