import type { NextFunction, Request, Response } from "express";
import { AppError } from "../domain/errors.ts";

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    error: {
      code: "ROUTE_NOT_FOUND",
      message: `No route for ${req.method} ${req.path}`,
    },
  });
}

// Express identifies error-handling middleware by function arity (4 params),
// so _req and _next must stay even though this handler doesn't use them.
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof AppError) {
    res.status(err.status).json(err.toJSON());
    return;
  }

  if (err instanceof SyntaxError && "body" in (err as object)) {
    res.status(400).json({
      error: { code: "VALIDATION_ERROR", message: "Request body is not valid JSON" },
    });
    return;
  }

  console.error("Unhandled error:", err);
  res.status(500).json({
    error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred" },
  });
}
