import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  out: "./migrations",
  schema: [
    "./src/schema/system-outbox.ts",
    "./src/schema/shared-controls.ts",
    "./src/schema/identity-core.ts",
    "./src/schema/creator-applications.ts",
    "./src/schema/creator-catalog.ts",
    "./src/schema/payments.ts",
  ],
});
