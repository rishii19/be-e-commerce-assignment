import type { DatabaseSync } from "node:sqlite";

export interface IdempotencyRecord {
  key: string;
  cartId: string;
  requestHash: string;
  statusCode: number;
  responseBody: unknown;
}

interface IdempotencyRow {
  key: string;
  cart_id: string;
  request_hash: string;
  status_code: number;
  response_body: string;
}

export function findIdempotencyRecord(
  db: DatabaseSync,
  key: string,
): IdempotencyRecord | undefined {
  const row = db
    .prepare(
      "SELECT key, cart_id, request_hash, status_code, response_body FROM idempotency_keys WHERE key = ?",
    )
    .get(key) as IdempotencyRow | undefined;
  if (!row) return undefined;
  return {
    key: row.key,
    cartId: row.cart_id,
    requestHash: row.request_hash,
    statusCode: row.status_code,
    responseBody: JSON.parse(row.response_body),
  };
}

/**
 * Records the outcome of a checkout attempt under its idempotency key so a
 * retry can be replayed verbatim instead of re-running business logic.
 * Called from inside the same transaction as the checkout itself so the
 * record and its effects (or lack thereof) commit or roll back together.
 */
export function saveIdempotencyRecord(
  db: DatabaseSync,
  record: { key: string; cartId: string; requestHash: string; statusCode: number; responseBody: unknown },
): void {
  db.prepare(
    `INSERT INTO idempotency_keys (key, cart_id, request_hash, status_code, response_body)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    record.key,
    record.cartId,
    record.requestHash,
    record.statusCode,
    JSON.stringify(record.responseBody),
  );
}
