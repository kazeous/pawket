import { decryptSensitiveField, encryptSensitiveField, type EncryptionEnvelope, type EncryptionKeyring } from "@pawket/security";
import { commissionFail, type CommissionBrief, type CommissionTerms } from "./contracts.js";
import { normalizeCommissionBrief, normalizeCommissionTerms } from "./policy.js";

type TermsRecord = "commission_quote_revisions" | "commission_terms_snapshots";
export function encryptCommissionTerms<R extends TermsRecord>(keyring: EncryptionKeyring, recordType: R, recordId: string, terms: CommissionTerms) {
  const encrypt = <F extends string>(fieldName: F, text: string) => encryptSensitiveField({ keyring, plaintext: JSON.stringify(text), binding: { recordType, recordId, fieldName } });
  return { policyRevisionId: terms.policyRevisionId, amountVnd: terms.amountVnd, turnaroundDays: terms.turnaroundDays,
    revisionAllowance: terms.revisionAllowance, reviewWindowDays: terms.reviewWindowDays,
    scopeEnvelope: encrypt("scope", terms.scope), deliverablesEnvelope: encrypt("deliverables", terms.deliverables),
    usageRightsEnvelope: encrypt("usage_rights", terms.usageRights), artistTermsEnvelope: encrypt("artist_terms", terms.artistTerms) };
}
type PrivateTerms<R extends TermsRecord> = Pick<CommissionTerms, "policyRevisionId" | "amountVnd" | "turnaroundDays" | "revisionAllowance" | "reviewWindowDays"> & {
  scopeEnvelope: EncryptionEnvelope<R, "scope">; deliverablesEnvelope: EncryptionEnvelope<R, "deliverables">;
  usageRightsEnvelope: EncryptionEnvelope<R, "usage_rights">; artistTermsEnvelope: EncryptionEnvelope<R, "artist_terms">;
};
export function decryptCommissionTerms<R extends TermsRecord>(keyring: EncryptionKeyring, recordType: R, recordId: string, row: PrivateTerms<R>): CommissionTerms {
  try {
    const decrypt = <F extends string>(fieldName: F, envelope: EncryptionEnvelope<R, F>): unknown => JSON.parse(decryptSensitiveField({ keyring, envelope, binding: { recordType, recordId, fieldName } }));
    return normalizeCommissionTerms({ policyRevisionId: row.policyRevisionId, amountVnd: row.amountVnd, turnaroundDays: row.turnaroundDays,
      revisionAllowance: row.revisionAllowance, reviewWindowDays: row.reviewWindowDays, scope: decrypt("scope", row.scopeEnvelope),
      deliverables: decrypt("deliverables", row.deliverablesEnvelope), usageRights: decrypt("usage_rights", row.usageRightsEnvelope), artistTerms: decrypt("artist_terms", row.artistTermsEnvelope) });
  } catch { return commissionFail("dependency_unavailable"); }
}
export function encryptCommissionBrief(keyring: EncryptionKeyring, orderId: string, brief: CommissionBrief) {
  return { textEnvelope: encryptSensitiveField({ keyring, plaintext: JSON.stringify(brief.text), binding: { recordType: "commission_briefs", recordId: orderId, fieldName: "text" } }),
    linksEnvelope: encryptSensitiveField({ keyring, plaintext: JSON.stringify(brief.referenceLinks), binding: { recordType: "commission_briefs", recordId: orderId, fieldName: "links" } }) };
}
export function decryptCommissionBrief(keyring: EncryptionKeyring, orderId: string, row: {
  textEnvelope: EncryptionEnvelope<"commission_briefs", "text">; linksEnvelope: EncryptionEnvelope<"commission_briefs", "links">;
}): CommissionBrief {
  try {
    return normalizeCommissionBrief({ text: JSON.parse(decryptSensitiveField({ keyring, envelope: row.textEnvelope, binding: { recordType: "commission_briefs", recordId: orderId, fieldName: "text" } })),
      referenceLinks: JSON.parse(decryptSensitiveField({ keyring, envelope: row.linksEnvelope, binding: { recordType: "commission_briefs", recordId: orderId, fieldName: "links" } })) });
  } catch { return commissionFail("dependency_unavailable"); }
}
