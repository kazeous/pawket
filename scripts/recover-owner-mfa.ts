import {
  OwnerMfaRecoveryError,
  ownerMfaRecoveryUsage,
  parseOwnerMfaRecoveryArguments,
  recoverOwnerMfa,
} from "../packages/admin/src/index.js";
import { loadServerEnv } from "../packages/config/src/index.js";
import { createDatabase } from "../packages/database/src/index.js";
import { createEncryptionKeyring } from "../packages/security/src/index.js";

async function main(): Promise<void> {
  let args;
  try {
    args = parseOwnerMfaRecoveryArguments(process.argv.slice(2));
  } catch {
    process.stderr.write(`${ownerMfaRecoveryUsage}\n`);
    process.exitCode = 2;
    return;
  }
  if (args.help) {
    process.stdout.write(`${ownerMfaRecoveryUsage}\n`);
    return;
  }

  const env = loadServerEnv();
  if (args.applicationRevision !== env.APP_REVISION) {
    process.stderr.write("Owner MFA recovery refused: INVALID_RECOVERY_INPUT\n");
    process.exitCode = 1;
    return;
  }
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
    const result = await recoverOwnerMfa(database.db, {
      userId: args.userId,
      configuredEmail: env.BOOTSTRAP_OWNER_EMAIL,
      incidentId: args.incidentId,
      repositoryEvidenceId: args.repositoryEvidenceId,
      hostEvidenceId: args.hostEvidenceId,
      authorizedAt: new Date(args.authorizedAt),
      emergencyReason: args.emergencyReason,
      confirmation: args.confirmation,
      applicationRevision: args.applicationRevision,
      keyring,
      now: new Date(),
    });
    process.stdout.write(
      `Owner MFA recovery completed for ${result.userId}; ${result.revokedSessionCount} session(s) revoked; MFA re-enrollment required.\n`,
    );
  } catch (error) {
    const code = error instanceof OwnerMfaRecoveryError ? error.code : "OWNER_MFA_RECOVERY_FAILED";
    process.stderr.write(`Owner MFA recovery refused: ${code}\n`);
    process.exitCode = 1;
  } finally {
    await database.close();
  }
}

void main().catch(() => {
  process.stderr.write("Owner MFA recovery refused: OWNER_MFA_RECOVERY_FAILED\n");
  process.exitCode = 1;
});
