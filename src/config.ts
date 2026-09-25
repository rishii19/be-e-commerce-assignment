export interface AppConfig {
  port: number;
  dbPath: string;
  couponMilestoneN: number;
  couponDiscountPercent: number;
}

function intFromEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) {
    throw new Error(`${name} must be an integer, got "${raw}"`);
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const couponMilestoneN = intFromEnv(env, "COUPON_MILESTONE_N", 5);
  const couponDiscountPercent = intFromEnv(env, "COUPON_DISCOUNT_PERCENT", 10);

  if (couponMilestoneN < 1) {
    throw new Error("COUPON_MILESTONE_N must be >= 1");
  }
  if (couponDiscountPercent < 1 || couponDiscountPercent > 100) {
    throw new Error("COUPON_DISCOUNT_PERCENT must be in the range (0, 100]");
  }

  return {
    port: intFromEnv(env, "PORT", 3000),
    dbPath: env.DB_PATH ?? "./data/app.db",
    couponMilestoneN,
    couponDiscountPercent,
  };
}
