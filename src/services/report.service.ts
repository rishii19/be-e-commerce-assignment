import type { DatabaseSync } from "node:sqlite";
import { buildReport } from "../repositories/reports.repo.ts";
import type { AdminReport } from "../domain/types.ts";

export function getReport(db: DatabaseSync): AdminReport {
  return buildReport(db);
}
