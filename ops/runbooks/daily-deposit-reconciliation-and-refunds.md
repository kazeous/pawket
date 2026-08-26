# Daily deposit reconciliation and refunds

Run at least twice each Vietnam business day and once before the bank cutoff.

1. Open the owner queue using a fresh TOTP step-up; never reconcile from email or chat evidence.
2. Match amount, hashed transfer reference, source-bank identity, and source-account fingerprint against the issued challenge. Do not copy raw bank data into notes, tickets, logs, or screenshots.
3. Classify any mismatch through the unmatched-deposit workflow. Funds are a liability, never revenue.
4. For a matched deposit, verify the stored calendar version and immutable `refundNotBefore`/`refundDue` dates.
5. Within the allowed window, send the refund manually to the locked same account, then record the bounded outcome and masked/fingerprinted evidence with fresh TOTP.
6. Confirm the refund state, audit event, outbox event, and applicant email disposition. Email failure does not change the refund deadline.

Escalate any due-today item not completed within the first check, and use the overdue runbook immediately after the deadline.
