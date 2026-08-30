import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "drizzle-kit";

const databaseDirectory = dirname(fileURLToPath(import.meta.url));
const databaseCwd = resolve(process.cwd()) === databaseDirectory;
const schemaPath = (name: string) => databaseCwd ? `./src/schema/${name}` : `./packages/database/src/schema/${name}`;

export default defineConfig({
  dialect: "postgresql",
  out: databaseCwd ? "./migrations" : "./packages/database/migrations",
  schema: [
    schemaPath("system-outbox.ts"),
    schemaPath("shared-controls.ts"),
    schemaPath("identity-core.ts"),
    schemaPath("creator-applications.ts"),
    schemaPath("creator-catalog.ts"),
    schemaPath("public-media.ts"),
    schemaPath("public-trust.ts"),
    schemaPath("payments.ts"),
  ],
});
