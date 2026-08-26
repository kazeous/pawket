import { randomUUID } from "node:crypto";

import {
  bootstrapOwner,
  OwnerBootstrapError,
} from "../packages/admin/src/owner-bootstrap.js";
import {
  ownerBootstrapUsage,
  parseOwnerBootstrapArguments,
} from "../packages/admin/src/owner-bootstrap-cli.js";
import { loadServerEnv } from "../packages/config/src/index.js";
import { createDatabase } from "../packages/database/src/client.js";
import { createEncryptionKeyring } from "../packages/security/src/encryption-envelope.js";

async function main(): Promise<void> {
  let args;
  try {
    args = parseOwnerBootstrapArguments(process.argv.slice(2));
  } catch {
    process.stderr.write(`${ownerBootstrapUsage}\n`);
    process.exitCode = 2;
    return;
  }
  if (args.help) {
    process.stdout.write(`${ownerBootstrapUsage}\n`);
    return;
  }

  const env = loadServerEnv();
  const database = createDatabase(env.DATABASE_URL);
  const keyring = createEncryptionKeyring({
    activeKeyId: env.PII_ACTIVE_KEY_ID,
    keys: Object.fromEntries(
      Object.entries(env.PII_KEYRING_JSON).map(([keyId, key]) => [
        keyId,
        Buffer.from(key, "base64"),
      ]),
    ),
  });

  try {
    const result = await bootstrapOwner(database.db, {
      userId: args.userId,
      configuredEmail: env.BOOTSTRAP_OWNER_EMAIL,
      confirmation: args.confirmation,
      applicationRevision: env.APP_REVISION,
      confirmedApplicationRevision: args.applicationRevision,
      requestId: `bootstrap:${randomUUID()}`,
      keyring,
      now: new Date(),
    });
    process.stdout.write(
      `Owner bootstrap completed for user ${result.userId}; revision ${env.APP_REVISION}; ${result.revokedSessionCount} session(s) revoked.\n`,
    );
  } catch (error) {
    const code = error instanceof OwnerBootstrapError ? error.code : "OWNER_BOOTSTRAP_FAILED";
    process.stderr.write(`Owner bootstrap refused: ${code}\n`);
    process.exitCode = 1;
  } finally {
    await database.close();
  }
}

void main().catch(() => {
  process.stderr.write("Owner bootstrap refused: OWNER_BOOTSTRAP_FAILED\n");
  process.exitCode = 1;
});
