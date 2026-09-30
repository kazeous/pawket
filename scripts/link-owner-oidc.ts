import { randomBytes } from "node:crypto";
import { open, unlink } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { parseArgs } from "node:util";
import { createDatabase } from "../packages/database/src/client.js";
import { parseOidcSessionEnv } from "../packages/config/src/oidc.js";
import { OidcOwnerLinkError, prepareOidcOwnerLink } from "../packages/identity/src/oidc-owner-link.js";

const usage = "link-owner-oidc --user-id ID --subject UUID --operator REF --evidence REF --revision SHA [--apply --confirm LINK_OWNER:ID:UUID:SHA --invitation-file /private/path]";
async function main() {
  const { values } = parseArgs({ options: { "user-id": { type: "string" }, subject: { type: "string" }, operator: { type: "string" }, evidence: { type: "string" },
    revision: { type: "string" }, apply: { type: "boolean" }, confirm: { type: "string" }, "invitation-file": { type: "string" }, help: { type: "boolean" } }, strict: true });
  if (values.help) { process.stdout.write(`${usage}\nDefault is a read-only dry run. Apply writes a private one-use invitation; it never prints it.\n`); return; }
  const provider = parseOidcSessionEnv(process.env);
  const databaseUrl = process.env.DATABASE_URL; const revision = process.env.APP_REVISION;
  if (!databaseUrl || !revision || !values["user-id"] || !values.subject || !values.operator || !values.evidence || !values.revision) throw new Error("INVALID_INPUT");
  const common = { provider, userId: values["user-id"], subject: values.subject, operatorReference: values.operator, evidenceReference: values.evidence,
    applicationRevision: revision, confirmedRevision: values.revision, now: new Date() };
  const db = createDatabase(databaseUrl); let file: Awaited<ReturnType<typeof open>> | undefined; let createdPath: string | undefined; let applied = false;
  try {
    if (!values.apply) {
      if (values.confirm || values["invitation-file"]) throw new Error("INVALID_INPUT");
      process.stdout.write(`${JSON.stringify(await prepareOidcOwnerLink(db.db, { ...common, mode: "dry_run" }))}\n`); return;
    }
    // Production ops run in the Linux container, where0600 is enforceable.
    const path = values["invitation-file"];
    if (process.platform === "win32" || !path || !isAbsolute(path) || !values.confirm) throw new Error("PRIVATE_INVITATION_FILE_REQUIRED");
    const invitation = randomBytes(32).toString("base64url");
    file = await open(path, "wx", 0o600); createdPath = path;
    if (((await file.stat()).mode & 0o077) !== 0) throw new Error("PRIVATE_INVITATION_FILE_REQUIRED");
    await file.writeFile(invitation, "utf8"); await file.sync(); await file.close(); file = undefined;
    const result = await prepareOidcOwnerLink(db.db, { ...common, mode: "apply", invitation, confirmation: values.confirm });
    applied = true; process.stdout.write(`${JSON.stringify(result)}\nInvitation saved to the requested private file. Open /auth/owner-link and use it within30 minutes.\n`);
  } finally {
    await file?.close();
    if (createdPath && !applied) await unlink(createdPath);
    await db.close();
  }
}
void main().catch((error: unknown) => {
  process.stderr.write(`Owner OIDC link refused: ${error instanceof OidcOwnerLinkError ? error.code : "OPERATION_FAILED"}\n${usage}\n`); process.exitCode = 1;
});
