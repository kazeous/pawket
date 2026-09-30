export class StepUpProofError extends Error {
  constructor(readonly code: "OWNER_TOTP_REQUIRED" | "RECENT_AUTH_REQUIRED") {
    super("Recent authentication is required");
    this.name = "StepUpProofError";
  }
}
