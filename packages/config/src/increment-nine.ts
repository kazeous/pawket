import { z } from "zod";
import type { CommissionPaymentsMode } from "@pawket/config/increment-six";

export const incrementNineEnvShape = {
  NOTIFICATIONS_MODE: z.enum(["disabled", "enabled"]).default("disabled"),
};
type Parsed = z.infer<z.ZodObject<typeof incrementNineEnvShape>>;
export type IncrementNineServerEnv = Parsed;
export type NotificationsMode = Parsed["NOTIFICATIONS_MODE"];
export class IncrementNineConfigError extends Error {
  constructor(readonly failures: ReadonlyArray<{ field: string; reason: string }>) {
    super(failures.map(({ field, reason }) => `${field} ${reason}`).join("; "));
    this.name = "IncrementNineConfigError";
  }
}
export function resolveIncrementNineEnv(parsed: Parsed & {
  COMMISSION_PAYMENTS_MODE: CommissionPaymentsMode;
}): IncrementNineServerEnv {
  if (parsed.COMMISSION_PAYMENTS_MODE !== "disabled" && parsed.NOTIFICATIONS_MODE !== "enabled") {
    throw new IncrementNineConfigError([
      { field: "COMMISSION_PAYMENTS_MODE", reason: "requires NOTIFICATIONS_MODE=enabled" },
    ]);
  }
  return { NOTIFICATIONS_MODE: parsed.NOTIFICATIONS_MODE };
}
