"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { StatusBanner } from "@/ui/status-banner";

export function LockedEndSession() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  async function endSession() {
    if (pending) return;
    setPending(true); setFailed(false);
    try {
      // CORS fetch preserves the real Origin even under Referrer-Policy: no-referrer.
      const response = await fetch("/help/locked/end", {
        method: "POST", mode: "cors", credentials: "same-origin", cache: "no-store", redirect: "error",
      });
      if (response.status !== 204) { setFailed(true); return; }
      router.replace("/help/locked?ended=1");
    } catch { setFailed(true); }
    finally { setPending(false); }
  }

  return <div className="flex flex-col gap-3">
    {failed ? <StatusBanner tone="error">Không thể kết thúc phiên. Vui lòng thử lại.</StatusBanner> : null}
    <Button type="button" variant="outline" className="self-start" disabled={pending} onClick={() => void endSession()}>
      {pending ? "Đang kết thúc phiên…" : failed ? "Thử lại" : "Kết thúc phiên"}
    </Button>
  </div>;
}
