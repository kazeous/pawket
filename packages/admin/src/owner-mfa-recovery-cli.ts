import type { PawketDatabase } from "@pawket/database";
import type { EncryptionKeyring } from "@pawket/security";

import {
  OwnerMfaRecoveryError,
  type OwnerMfaRecoveryInput,
  type OwnerMfaRecoveryResult,
} from "./owner-mfa-recovery.js";

const operationalIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
const databaseCleanupWarning =
  "Owner MFA recovery cleanup warning: DATABASE_CLOSE_FAILED\n";

export type OwnerMfaRecoveryCliArguments =
  | { help: true }
  | {
      help: false;
      userId: string;
      incidentId: string;
      repositoryEvidenceId: string;
      hostEvidenceId: string;
      authorizedAt: string;
      emergencyReason?: "active_refund_deadline";
      confirmation: string;
      applicationRevision: string;
    };

export const ownerMfaRecoveryUsage = [
  "Usage: pnpm recover:owner-mfa -- --user-id=<exact-user-id> --incident-id=<incident-id> --repo-proof=<evidence-id> --host-proof=<evidence-id> --authorized-at=<ISO-8601> --revision=<APP_REVISION> --confirm=<confirmation>",
  "Confirmation format: RECOVER_OWNER_MFA:<exact-user-id>:<incident-id>",
  "Emergency only: --emergency-reason=active_refund_deadline",
  "Repository/host references, authorization time, and emergency need are operator attestations governed outside Pawket.",
].join("\n");

type OwnerMfaRecoveryCliEnvironment = Readonly<{
  OWNER_MFA_RECOVERY_MODE: "disabled" | "external_manual";
  OWNER_MFA_RECOVERY_ACCEPTANCE_REFERENCE?: string;
  OWNER_MFA_RECOVERY_REHEARSED_AT?: string;
  APP_REVISION: string;
  DATABASE_URL: string;
  BOOTSTRAP_OWNER_EMAIL: string;
  PII_ACTIVE_KEY_ID: string;
  PII_KEYRING_JSON: Record<string, string>;
}>;

type OwnerMfaRecoveryDatabaseHandle = Readonly<{
  db: PawketDatabase;
  close: () => Promise<void>;
}>;

export type OwnerMfaRecoveryCliDependencies = Readonly<{
  loadServerEnv: () => OwnerMfaRecoveryCliEnvironment;
  createDatabase: (databaseUrl: string) => OwnerMfaRecoveryDatabaseHandle;
  createEncryptionKeyring: (input: {
    activeKeyId: string;
    keys: Record<string, Uint8Array>;
  }) => EncryptionKeyring;
  recoverOwnerMfa: (
    db: PawketDatabase,
    input: OwnerMfaRecoveryInput,
  ) => Promise<OwnerMfaRecoveryResult>;
  now: () => Date;
}>;

export type OwnerMfaRecoveryCliResult = Readonly<{
  exitCode: 0 | 1 | 2 | 3;
  stdout: string;
  stderr: string;
}>;

function cliResult(
  exitCode: 0 | 1 | 2 | 3,
  output: { stdout?: string; stderr?: string },
): OwnerMfaRecoveryCliResult {
  return {
    exitCode,
    stdout: output.stdout ?? "",
    stderr: output.stderr ?? "",
  };
}

export function parseOwnerMfaRecoveryArguments(
  args: readonly string[],
): OwnerMfaRecoveryCliArguments {
  const forwarded = args.filter((argument) => argument !== "--");
  if (forwarded.includes("--help") || forwarded.includes("-h")) return { help: true };

  const allowed = new Set([
    "user-id",
    "incident-id",
    "repo-proof",
    "host-proof",
    "authorized-at",
    "emergency-reason",
    "revision",
    "confirm",
  ]);
  const values = new Map<string, string>();
  for (const argument of forwarded) {
    const separator = argument.indexOf("=");
    const key = argument.slice(2, separator);
    const value = argument.slice(separator + 1);
    if (
      !argument.startsWith("--") ||
      separator <= 2 ||
      !allowed.has(key) ||
      values.has(key) ||
      !value
    ) {
      throw new Error("INVALID_OWNER_MFA_RECOVERY_ARGUMENTS");
    }
    values.set(key, value);
  }
  const required = [
    "user-id",
    "incident-id",
    "repo-proof",
    "host-proof",
    "authorized-at",
    "revision",
    "confirm",
  ] as const;
  if (required.some((key) => !values.get(key))) {
    throw new Error("INVALID_OWNER_MFA_RECOVERY_ARGUMENTS");
  }
  const emergencyReason = values.get("emergency-reason");
  if (emergencyReason && emergencyReason !== "active_refund_deadline") {
    throw new Error("INVALID_OWNER_MFA_RECOVERY_ARGUMENTS");
  }
  return {
    help: false,
    userId: values.get("user-id")!,
    incidentId: values.get("incident-id")!,
    repositoryEvidenceId: values.get("repo-proof")!,
    hostEvidenceId: values.get("host-proof")!,
    authorizedAt: values.get("authorized-at")!,
    emergencyReason: emergencyReason as "active_refund_deadline" | undefined,
    applicationRevision: values.get("revision")!,
    confirmation: values.get("confirm")!,
  };
}

export async function runOwnerMfaRecoveryCli(
  args: readonly string[],
  dependencies: OwnerMfaRecoveryCliDependencies,
): Promise<OwnerMfaRecoveryCliResult> {
  let parsedArguments: OwnerMfaRecoveryCliArguments;
  try {
    parsedArguments = parseOwnerMfaRecoveryArguments(args);
  } catch {
    return cliResult(2, { stderr: `${ownerMfaRecoveryUsage}\n` });
  }
  if (parsedArguments.help) {
    return cliResult(0, { stdout: `${ownerMfaRecoveryUsage}\n` });
  }

  const environment = dependencies.loadServerEnv();
  if (
    environment.OWNER_MFA_RECOVERY_MODE !== "external_manual" ||
    !environment.OWNER_MFA_RECOVERY_ACCEPTANCE_REFERENCE ||
    !operationalIdentifierPattern.test(
      environment.OWNER_MFA_RECOVERY_ACCEPTANCE_REFERENCE,
    ) ||
    !environment.OWNER_MFA_RECOVERY_REHEARSED_AT
  ) {
    return cliResult(1, {
      stderr: "Owner MFA recovery refused: OWNER_MFA_RECOVERY_DISABLED\n",
    });
  }
  const now = dependencies.now();
  const rehearsedAt = new Date(environment.OWNER_MFA_RECOVERY_REHEARSED_AT);
  if (Number.isNaN(rehearsedAt.getTime()) || rehearsedAt > now) {
    return cliResult(1, {
      stderr: "Owner MFA recovery refused: OWNER_MFA_RECOVERY_DISABLED\n",
    });
  }
  if (parsedArguments.applicationRevision !== environment.APP_REVISION) {
    return cliResult(1, {
      stderr: "Owner MFA recovery refused: INVALID_RECOVERY_INPUT\n",
    });
  }

  let database: OwnerMfaRecoveryDatabaseHandle;
  let operationResult: OwnerMfaRecoveryCliResult;
  try {
    database = dependencies.createDatabase(environment.DATABASE_URL);
  } catch {
    return cliResult(1, {
      stderr: "Owner MFA recovery refused: OWNER_MFA_RECOVERY_FAILED\n",
    });
  }

  try {
    const keyring = dependencies.createEncryptionKeyring({
      activeKeyId: environment.PII_ACTIVE_KEY_ID,
      keys: Object.fromEntries(
        Object.entries(environment.PII_KEYRING_JSON).map(([keyId, key]) => [
          keyId,
          Buffer.from(key, "base64"),
        ]),
      ),
    });
    const result = await dependencies.recoverOwnerMfa(database.db, {
      userId: parsedArguments.userId,
      configuredEmail: environment.BOOTSTRAP_OWNER_EMAIL,
      incidentId: parsedArguments.incidentId,
      repositoryEvidenceId: parsedArguments.repositoryEvidenceId,
      hostEvidenceId: parsedArguments.hostEvidenceId,
      acceptanceReference: environment.OWNER_MFA_RECOVERY_ACCEPTANCE_REFERENCE,
      rehearsedAt,
      authorizedAt: new Date(parsedArguments.authorizedAt),
      emergencyReason: parsedArguments.emergencyReason,
      confirmation: parsedArguments.confirmation,
      applicationRevision: parsedArguments.applicationRevision,
      keyring,
      now,
    });
    operationResult = cliResult(0, {
      stdout: `Owner MFA recovery completed; ${result.revokedSessionCount} session(s) revoked; MFA re-enrollment required.\n`,
    });
  } catch (error) {
    const code =
      error instanceof OwnerMfaRecoveryError ? error.code : "OWNER_MFA_RECOVERY_FAILED";
    operationResult = cliResult(1, {
      stderr: `Owner MFA recovery refused: ${code}\n`,
    });
  }

  try {
    await database.close();
  } catch {
    return {
      ...operationResult,
      exitCode: operationResult.exitCode === 0 ? 3 : operationResult.exitCode,
      stderr: `${operationResult.stderr}${databaseCleanupWarning}`,
    };
  }
  return operationResult;
}
