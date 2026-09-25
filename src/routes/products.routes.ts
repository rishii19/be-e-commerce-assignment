import { Router } from "express";
import type { DatabaseSync } from "node:sqlite";
import * as productsRepo from "../repositories/products.repo.ts";
import { AppError } from "../domain/errors.ts";

export function createProductsRouter(db: DatabaseSync): Router {
  const router = Router();

  router.get("/", (_req, res) => {
    res.json({ products: productsRepo.listProducts(db) });
  });

  router.get("/:id", (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      throw new AppError("VALIDATION_ERROR", "id must be an integer");
    }
    const product = productsRepo.findProductById(db, id);
    if (!product) {
      throw new AppError("PRODUCT_NOT_FOUND", `Product ${id} does not exist`);
    }
    res.json(product);
  });

  return router;
}
