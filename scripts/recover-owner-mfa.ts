// Local factors are historical evidence only. Recovery must happen at authentik.
process.stderr.write("AUTH_MOVED: Recover the owner at authentik, then follow the audited SSO session-revocation runbook. No local factors were changed.\n");
process.exitCode = 1;
