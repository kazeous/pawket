import type { createTipHttpHandlers } from "@pawket/tips";
import { isRecord, readTipReceipt, type TipReceiptPageState } from "../ui/tips/tip-client";

export async function resolveTipReceiptPage(input: Readonly<{
  reference: string; headers: Headers; appBaseUrl: string;
  handlers: Pick<ReturnType<typeof createTipHttpHandlers>, "receipt">;
  authenticate(headers: Headers): Promise<Readonly<{ userId: string }> | null>;
}>): Promise<TipReceiptPageState> {
  if (!/^PW[0-9A-F]{20}$/u.test(input.reference)) return { kind: "unavailable", code: "not_available" };
  try {
    const response = await input.handlers.receipt(new Request(new URL(`/api/v1/tips/${input.reference}`, input.appBaseUrl), { headers: input.headers }), input.reference);
    const value: unknown = await response.json();
    if (response.ok) return { kind: "ready", data: readTipReceipt(value, input.reference) };
    let code = isRecord(value) && typeof value.code === "string" && ["not_available", "payments_disabled", "rate_limited"].includes(value.code) ? value.code : "dependency_unavailable";
    if (code === "not_available") {
      const name = `__Secure-pawket_tip_${input.reference}=`;
      const hasCookie = (input.headers.get("cookie") ?? "").split(";").some((part) => part.trim().startsWith(name));
      if (!hasCookie && !(await input.authenticate(input.headers))) code = "missing_access";
    }
    return { kind: "unavailable", code };
  } catch { return { kind: "unavailable", code: "dependency_unavailable" }; }
}
