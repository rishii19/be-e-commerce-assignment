import type { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { createDatabase } from "./connection.ts";
import { loadConfig } from "../config.ts";

export interface SeedProduct {
  name: string;
  priceCents: number;
  inventory: number;
}

export const SEED_PRODUCTS: SeedProduct[] = [
  { name: "Wireless Mouse", priceCents: 2499, inventory: 100 },
  { name: "Mechanical Keyboard", priceCents: 8999, inventory: 50 },
  { name: "USB-C Hub", priceCents: 4599, inventory: 75 },
  { name: "27-inch Monitor", priceCents: 24999, inventory: 20 },
  // Deliberately scarce so tests/reviewers can exercise the oversell guard.
  { name: "Limited Edition Desk Mat", priceCents: 1999, inventory: 2 },
];

export function seedIfEmpty(db: DatabaseSync): void {
  const row = db.prepare("SELECT COUNT(*) AS count FROM products").get() as {
    count: number;
  };
  if (row.count > 0) return;

  const insert = db.prepare(
    "INSERT INTO products (name, price_cents, inventory) VALUES (?, ?, ?)",
  );
  for (const product of SEED_PRODUCTS) {
    insert.run(product.name, product.priceCents, product.inventory);
  }
}

const isMainModule =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  const config = loadConfig();
  const db = createDatabase(config.dbPath);
  seedIfEmpty(db);
  db.close();
  console.log(`Seeded ${SEED_PRODUCTS.length} products into ${config.dbPath}`);
}
