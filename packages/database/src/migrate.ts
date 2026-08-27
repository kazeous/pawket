import { fileURLToPath } from "node:url";

import { migrate } from "drizzle-orm/postgres-js/migrator";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { importConfiguredBusinessCalendarVersion } from "./business-calendar-repository.js";
import * as schema from "./schema.js";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required to run database migrations");
}

const client = postgres(databaseUrl, { max: 1 });
const db = drizzle(client, { schema });
const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));

function readConfiguredBusinessCalendar():
  | { version: string; holidayDates: string[] }
  | undefined {
  const version = process.env.VN_BUSINESS_CALENDAR_VERSION?.trim();
  const serializedHolidays = process.env.VN_BUSINESS_HOLIDAYS?.trim();
  if (!version && !serializedHolidays) return undefined;
  if (!version || !serializedHolidays) {
    throw new Error("Configured business calendar is invalid");
  }

  try {
    const parsed = JSON.parse(serializedHolidays) as unknown;
    if (
      !Array.isArray(parsed) ||
      parsed.length > 64 ||
      parsed.some((date) => typeof date !== "string")
    ) {
      throw new Error("Configured business calendar is invalid");
    }
    return { version, holidayDates: parsed };
  } catch {
    throw new Error("Configured business calendar is invalid");
  }
}

try {
  await migrate(db, { migrationsFolder });
  const calendar = readConfiguredBusinessCalendar();
  if (calendar) {
    await db.transaction((tx) => importConfiguredBusinessCalendarVersion(tx, calendar));
  }
} finally {
  await client.end();
}
