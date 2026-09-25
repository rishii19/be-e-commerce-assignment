import type { AddressInfo } from "node:net";
import type { DatabaseSync } from "node:sqlite";
import { createDatabase } from "../../src/db/connection.ts";
import { seedIfEmpty } from "../../src/db/seed.ts";
import { createApp } from "../../src/app.ts";

export interface TestServer {
  baseUrl: string;
  db: DatabaseSync;
  close: () => Promise<void>;
}

export interface TestServerOptions {
  couponMilestoneN?: number;
  couponDiscountPercent?: number;
}

export async function startTestServer(options: TestServerOptions = {}): Promise<TestServer> {
  const db = createDatabase(":memory:");
  seedIfEmpty(db);

  const app = createApp(db, {
    couponMilestoneN: options.couponMilestoneN ?? 5,
    couponDiscountPercent: options.couponDiscountPercent ?? 10,
  });

  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    db,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

// Deliberately `any` by default: tests assert directly on response shape
// rather than re-declaring every endpoint's response type in test code.
export interface ApiResponse<T = any> {
  status: number;
  body: T;
}

async function request<T = any>(
  url: string,
  init: RequestInit,
): Promise<ApiResponse<T>> {
  const res = await fetch(url, init);
  const text = await res.text();
  const body = text.length > 0 ? JSON.parse(text) : undefined;
  return { status: res.status, body: body as T };
}

export function postJson<T = any>(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<ApiResponse<T>> {
  return request<T>(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

export function patchJson<T = any>(
  url: string,
  body: unknown,
): Promise<ApiResponse<T>> {
  return request<T>(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function getJson<T = any>(url: string): Promise<ApiResponse<T>> {
  return request<T>(url, { method: "GET" });
}

export function deleteJson<T = any>(url: string): Promise<ApiResponse<T>> {
  return request<T>(url, { method: "DELETE" });
}

export async function createCartWithItem(
  baseUrl: string,
  productId: number,
  quantity: number,
): Promise<string> {
  const cart = await postJson<{ id: string }>(`${baseUrl}/carts`, {});
  await postJson(`${baseUrl}/carts/${cart.body.id}/items`, { productId, quantity });
  return cart.body.id;
}
