# PII key rotation

1. Generate the replacement key through the approved secret manager; never place key bytes in Git, logs, tickets, or command history.
2. Add the new key to `PII_KEYRING_JSON`, set only its key ID as `PII_ACTIVE_KEY_ID`, and keep old keys available for decryption.
3. Deploy and verify mixed-key reads plus new writes on the reviewed revision. Roll back configuration if any envelope cannot decrypt.
4. Run a separately reviewed, idempotent re-encryption pass and record counts by key ID only—never plaintext or row identifiers.
5. Scan again. Retire an old decrypt key only after two independent checks report zero remaining envelopes and backups/rollback implications are accepted.
