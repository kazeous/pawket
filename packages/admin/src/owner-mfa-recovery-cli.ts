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
].join("\n");

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
