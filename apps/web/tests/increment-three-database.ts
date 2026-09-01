import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { createDatabase, identityUsers } from "@pawket/database";
import { eq, sql } from "drizzle-orm";

import { browserDatabaseUrl } from "./increment-three-fixture";

const sharedDatabaseUrl = "postgresql://pawket:pawket_dev_only@127.0.0.1:5432/pawket_dev";

export async function prepareIncrementThreeDatabase() {
  if (process.env.PAWKET_TASK15_DATABASE_PREPARED === "1") return;
  const shared = createDatabase(sharedDatabaseUrl);
  const sentinelId = `task15-sentinel-${randomUUID()}`;
  const now = new Date();
  try {
    await shared.db.insert(identityUsers).values({ id: sentinelId, name: "Task 15 sentinel", email: `${sentinelId}@example.test`, canonicalEmail: `${sentinelId}@example.test`, emailVerified: true, emailVerifiedAt: now, emailVerificationProvenance: "password_email_challenge", accessStatus: "active", authorizationVersion: 1, createdAt: now, updatedAt: now });
    await shared.db.execute(sql.raw("drop database if exists pawket_task15_browser with (force)"));
    await shared.db.execute(sql.raw("create database pawket_task15_browser"));
    const [preserved] = await shared.db.select({ id: identityUsers.id }).from(identityUsers).where(eq(identityUsers.id, sentinelId));
    if (!preserved) throw new Error("Shared development sentinel was not preserved");
  } finally {
    await shared.db.delete(identityUsers).where(eq(identityUsers.id, sentinelId)).catch(() => undefined);
    await shared.close();
  }
  const workspaceRoot = path.resolve(import.meta.dirname, "../../..");
  execFileSync(process.execPath, [path.join(workspaceRoot, "node_modules/tsx/dist/cli.mjs"), path.join(workspaceRoot, "packages/database/src/migrate.ts")], { cwd: workspaceRoot, env: { ...process.env, DATABASE_URL: browserDatabaseUrl }, stdio: "inherit" });
  process.env.PAWKET_TASK15_DATABASE_PREPARED = "1";
}
