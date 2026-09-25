import type { DatabaseSync } from "node:sqlite";
import type { Product } from "../domain/types.ts";

interface ProductRow {
  id: number;
  name: string;
  price_cents: number;
  inventory: number;
}

function toProduct(row: ProductRow): Product {
  return {
    id: row.id,
    name: row.name,
    priceCents: row.price_cents,
    inventory: row.inventory,
  };
}

export function findProductById(db: DatabaseSync, id: number): Product | undefined {
  const row = db
    .prepare("SELECT id, name, price_cents, inventory FROM products WHERE id = ?")
    .get(id) as unknown as ProductRow | undefined;
  return row ? toProduct(row) : undefined;
}

export function listProducts(db: DatabaseSync): Product[] {
  const rows = db
    .prepare("SELECT id, name, price_cents, inventory FROM products ORDER BY id")
    .all() as unknown as ProductRow[];
  return rows.map(toProduct);
}

/**
 * Decrements inventory only if enough stock remains, in one atomic
 * statement. Returns false (no rows changed) instead of allowing inventory
 * to go negative, so callers can detect a lost race even though, within a
 * single process, `withTransaction` already prevents concurrent callers
 * from interleaving.
 */
export function decrementInventory(
  db: DatabaseSync,
  productId: number,
  quantity: number,
): boolean {
  const result = db
    .prepare(
      "UPDATE products SET inventory = inventory - ? WHERE id = ? AND inventory >= ?",
    )
    .run(quantity, productId, quantity);
  return result.changes === 1;
}
