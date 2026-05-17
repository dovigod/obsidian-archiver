import type { Config } from "drizzle-kit";

export default {
  schema: "./src/core/db/schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
} satisfies Config;
