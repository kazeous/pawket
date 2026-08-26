# Unmatched deposits

1. Preserve the row and liability state; do not delete, merge, or classify the funds as revenue.
2. Choose only the bounded mismatch reason supported by the evidence. Keep private notes free of full account numbers and transfer references.
3. Investigate using the bank system and internal fingerprints. Never ask an applicant to send credentials, OTPs, or full statements.
4. If a valid challenge can be established, use the normal reconciliation transaction. Otherwise maintain `refund_required` or `attention_required` until an evidenced manual resolution exists.
5. Record the owner, fresh-TOTP proof, request ID, masked evidence, decision, and UTC time. Verify liability and alert gauges after resolution.
