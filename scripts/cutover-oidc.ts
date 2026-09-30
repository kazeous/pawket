import { parseArgs } from "node:util";
import { createDatabase } from "../packages/database/src/client.js";
import { parseOidcSessionEnv } from "../packages/config/src/oidc.js";
import { OidcCutoverError, performOidcCutover } from "../packages/identity/src/oidc-cutover.js";

const usage = "cutover-oidc --owner-user-id ID --operator REF --acceptance REF --backup REF --recovery REF --revision SHA --rollback-until ISO --backup-retained-until ISO [--apply --old-issuers-stopped --confirm CUTOVER_OIDC:CLIENT_ID:SHA]";
async function main() {
  const { values } = parseArgs({ strict: true, options: {
    "owner-user-id": { type: "string" }, operator: { type: "string" }, acceptance: { type: "string" }, backup: { type: "string" }, recovery: { type: "string" },
    revision: { type: "string" }, "rollback-until": { type: "string" }, "backup-retained-until": { type: "string" },
    apply: { type: "boolean" }, "old-issuers-stopped": { type: "boolean" }, confirm: { type: "string" }, help: { type: "boolean" },
  } });
  if (values.help) { process.stdout.write(`${usage}\nDefault is read-only. Apply requires stopped/drained legacy web and delivery workers, verified backup and recovery evidence.\n`); return; }
  const revision = process.env.APP_REVISION; const url = process.env.DATABASE_URL;
  if (!url || !revision || !values.revision || !values["owner-user-id"] || !values.operator || !values.acceptance || !values.backup || !values.recovery || !values["rollback-until"] || !values["backup-retained-until"]) throw new Error();
  if (values.apply ? !values["old-issuers-stopped"] || !values.confirm : values["old-issuers-stopped"] || values.confirm) throw new OidcCutoverError("CONFIRMATION_REQUIRED");
  const provider = parseOidcSessionEnv(process.env);
  const common = { provider, ownerUserId: values["owner-user-id"], operatorReference: values.operator, acceptanceReference: values.acceptance,
    backupReference: values.backup, recoveryReference: values.recovery, applicationRevision: revision, confirmedRevision: values.revision,
    rollbackUntil: new Date(values["rollback-until"]), backupRetainedUntil: new Date(values["backup-retained-until"]), now: new Date() };
  const database = createDatabase(url);
  try {
    const result = await performOidcCutover(database.db, values.apply ? { ...common, mode: "apply", confirmation: values.confirm!, oldIssuersStopped: true } : { ...common, mode: "dry_run" });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally { await database.close(); }
}
void main().catch((error: unknown) => {
  process.stderr.write(`OIDC cutover refused: ${error instanceof OidcCutoverError ? error.code : "OPERATION_FAILED"}\n${usage}\n`); process.exitCode = 1;
});
