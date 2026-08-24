import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./packages/identity/tests/conformance/generated/auth-schema.ts",
  out: "./packages/identity/tests/conformance/migrations",
  dbCredentials: {
    url: "postgresql://schema-generation-only:unused@localhost:5432/unused",
  },
});
