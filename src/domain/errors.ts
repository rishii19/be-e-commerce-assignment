export type ErrorCode =
  | "VALIDATION_ERROR"
  | "PRODUCT_NOT_FOUND"
  | "CART_NOT_FOUND"
  | "CART_ITEM_NOT_FOUND"
  | "CART_ALREADY_CHECKED_OUT"
  | "CART_EMPTY"
  | "INSUFFICIENT_INVENTORY"
  | "ORDER_NOT_FOUND"
  | "COUPON_NOT_FOUND"
  | "COUPON_ALREADY_REDEEMED"
  | "MILESTONE_NOT_ELIGIBLE"
  | "IDEMPOTENCY_KEY_REQUIRED"
  | "IDEMPOTENCY_KEY_CONFLICT";

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  PRODUCT_NOT_FOUND: 404,
  CART_NOT_FOUND: 404,
  CART_ITEM_NOT_FOUND: 404,
  CART_ALREADY_CHECKED_OUT: 409,
  CART_EMPTY: 400,
  INSUFFICIENT_INVENTORY: 409,
  ORDER_NOT_FOUND: 404,
  COUPON_NOT_FOUND: 404,
  COUPON_ALREADY_REDEEMED: 409,
  MILESTONE_NOT_ELIGIBLE: 409,
  IDEMPOTENCY_KEY_REQUIRED: 400,
  IDEMPOTENCY_KEY_CONFLICT: 422,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.details = details;
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details !== undefined ? { details: this.details } : {}),
      },
    };
  }
}
