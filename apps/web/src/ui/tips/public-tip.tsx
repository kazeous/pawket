import { loadServerEnv } from "@pawket/config";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { getPlatformRuntime } from "@/platform/runtime";
import { TipForm } from "./tip-form";

export async function PublicTip({ handle }: Readonly<{ handle: string }>) {
  if (loadServerEnv().TIP_PAYMENTS_MODE !== "manual_only") return null;
  let offering;
  try { offering = await getPlatformRuntime().publicTips.getPublicOffering(handle); }
  catch { return <Alert><AlertTitle>Chưa tải được phần tip</AlertTitle><AlertDescription>Vui lòng quay lại sau để kiểm tra khả năng nhận tip của nghệ sĩ.</AlertDescription></Alert>; }
  return offering ? <TipForm offering={offering} /> : null;
}
