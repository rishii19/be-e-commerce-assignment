import { createApp } from "./app.ts";
import { createDatabase } from "./db/connection.ts";
import { seedIfEmpty } from "./db/seed.ts";
import { loadConfig } from "./config.ts";

const config = loadConfig();
const db = createDatabase(config.dbPath);
seedIfEmpty(db);

const app = createApp(db, config);

app.listen(config.port, () => {
  console.log(`Checkout service listening on http://localhost:${config.port}`);
  console.log(`Database: ${config.dbPath}`);
  console.log(
    `Coupon rules: every ${config.couponMilestoneN}th successful order earns a ${config.couponDiscountPercent}% coupon`,
  );
});
