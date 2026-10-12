"use client";
import { tipRequest } from "../tips/tip-client";
import { commissionErrorText } from "../commissions/commission-client";
import { CommandFeedback, useCommissionCommand } from "../commissions/commission-session";
import { trustErrorText } from "./trust-client";

// Reuse a page's existing actor verification, or let the authenticated POST verify
// the session. Standalone trust actions never create a polling boundary.
export function useTrustCommand(actorUserId?: string) {
  return useCommissionCommand(tipRequest, { sessionOptional: true, ...(actorUserId ? { actorUserId } : {}) });
}
export function TrustCommandFeedback({ command }: Readonly<{ command: ReturnType<typeof useTrustCommand> }>) {
  return <CommandFeedback command={command} errorText={(code) => trustErrorText(code) ?? commissionErrorText(code)} />;
}
