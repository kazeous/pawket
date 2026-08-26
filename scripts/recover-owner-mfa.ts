import {
  runOwnerMfaRecoveryCli,
  recoverOwnerMfa,
} from "../packages/admin/src/index.js";
import { loadServerEnv } from "../packages/config/src/index.js";
import { createDatabase } from "../packages/database/src/index.js";
import { createEncryptionKeyring } from "../packages/security/src/index.js";

async function main(): Promise<void> {
  const result = await runOwnerMfaRecoveryCli(process.argv.slice(2), {
    loadServerEnv,
    createDatabase,
    createEncryptionKeyring,
    recoverOwnerMfa,
    now: () => new Date(),
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}

void main().catch(() => {
  process.stderr.write("Owner MFA recovery refused: OWNER_MFA_RECOVERY_FAILED\n");
  process.exitCode = 1;
});
