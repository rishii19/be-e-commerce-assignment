import { Router } from "express";
import type { DatabaseSync } from "node:sqlite";
import * as cartService from "../services/cart.service.ts";
import * as checkoutService from "../services/checkout.service.ts";
import { AppError } from "../domain/errors.ts";

function parseProductIdParam(raw: string): number {
  const id = Number(raw);
  if (!Number.isInteger(id)) {
    throw new AppError("VALIDATION_ERROR", "productId path parameter must be an integer");
  }
  return id;
}

export function createCartsRouter(db: DatabaseSync): Router {
  const router = Router();

  router.post("/", (_req, res) => {
    const cart = cartService.createCart(db);
    res.status(201).json(cartService.viewCart(db, cart.id));
  });

  router.get("/:cartId", (req, res) => {
    res.json(cartService.viewCart(db, req.params.cartId));
  });

  router.post("/:cartId/items", (req, res) => {
    const { productId, quantity } = req.body ?? {};
    const view = cartService.addItem(db, req.params.cartId, productId, quantity);
    res.status(201).json(view);
  });

  router.patch("/:cartId/items/:productId", (req, res) => {
    const productId = parseProductIdParam(req.params.productId);
    const { quantity } = req.body ?? {};
    const view = cartService.updateItemQuantity(db, req.params.cartId, productId, quantity);
    res.json(view);
  });

  router.delete("/:cartId/items/:productId", (req, res) => {
    const productId = parseProductIdParam(req.params.productId);
    const view = cartService.removeItem(db, req.params.cartId, productId);
    res.json(view);
  });

  router.post("/:cartId/checkout", (req, res) => {
    const { couponCode } = req.body ?? {};
    if (couponCode !== undefined && couponCode !== null && typeof couponCode !== "string") {
      throw new AppError("VALIDATION_ERROR", "couponCode must be a string");
    }
    const result = checkoutService.checkout(db, {
      cartId: req.params.cartId,
      couponCode: couponCode ?? null,
      idempotencyKey: req.get("Idempotency-Key") ?? undefined,
    });
    if (result.replayed) {
      res.setHeader("Idempotent-Replay", "true");
    }
    res.status(result.statusCode).json(result.order);
  });

  return router;
}
