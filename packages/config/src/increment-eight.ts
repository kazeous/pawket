import { z } from "zod";
import type { CommissionPaymentsMode } from "@pawket/config/increment-six";
import type { CommissionFulfillmentMode } from "@pawket/config/increment-seven";

export const incrementEightEnvShape = {
  COMMISSION_RESOLUTION_MODE: z.enum(["disabled", "enabled"]).default("disabled"),
};
type Parsed = z.infer<z.ZodObject<typeof incrementEightEnvShape>>;
export type IncrementEightServerEnv = Parsed;
export type CommissionResolutionMode = Parsed["COMMISSION_RESOLUTION_MODE"];
export class IncrementEightConfigError extends Error {
  constructor(readonly failures: ReadonlyArray<{ field: string; reason: string }>) {
    super(failures.map(({ field, reason }) => `${field} ${reason}`).join("; "));
    this.name = "IncrementEightConfigError";
  }
}
export function resolveIncrementEightEnv(parsed: Parsed & {
  COMMISSION_FULFILLMENT_MODE: CommissionFulfillmentMode; COMMISSION_PAYMENTS_MODE: CommissionPaymentsMode;
}): IncrementEightServerEnv {
  const failures: Array<{ field: string; reason: string }> = [];
  if (parsed.COMMISSION_RESOLUTION_MODE === "enabled" && parsed.COMMISSION_FULFILLMENT_MODE !== "enabled") {
    failures.push({ field: "COMMISSION_RESOLUTION_MODE", reason: "requires COMMISSION_FULFILLMENT_MODE=enabled" });
  }
  if (parsed.COMMISSION_PAYMENTS_MODE !== "disabled" && (parsed.COMMISSION_FULFILLMENT_MODE !== "enabled" || parsed.COMMISSION_RESOLUTION_MODE !== "enabled")) {
    failures.push({ field: "COMMISSION_PAYMENTS_MODE", reason: "requires COMMISSION_FULFILLMENT_MODE=enabled and COMMISSION_RESOLUTION_MODE=enabled" });
  }
  if (failures.length) throw new IncrementEightConfigError(failures);
  return { COMMISSION_RESOLUTION_MODE: parsed.COMMISSION_RESOLUTION_MODE };
}
