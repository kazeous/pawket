"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ExpiredHelpLink, LockedHelpShell } from "@/ui/trust/locked-help-shell";
import { StatusBanner } from "@/ui/status-banner";

export default function LockedHelpPage() {
  const router = useRouter(); const exchange = useRef<Promise<"accepted" | "expired" | "ended"> | null>(null);
  const [state, setState] = useState<"checking" | "expired" | "ended">("checking");
  useEffect(() => {
    // Retain only the exchange promise so StrictMode cannot consume the fragment twice.
    if (!exchange.current) exchange.current = (async () => {
      const fragment = window.location.hash;
      window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
      if (!fragment && new URLSearchParams(window.location.search).get("ended") === "1") return "ended";
      const values = new URLSearchParams(fragment.slice(1)); const token = values.get("t");
      if ([...values.keys()].length !== 1 || !token || !/^[A-Za-z0-9_-]{43}$/u.test(token)) return "expired";
      try {
        const response = await fetch("/help/locked/session", { method: "POST", credentials: "same-origin", cache: "no-store",
          headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
        return response.status === 204 ? "accepted" : "expired";
      } catch { return "expired"; }
    })();
    let alive = true;
    void exchange.current.then((result) => { if (!alive) return; if (result === "accepted") router.replace("/help/locked/case"); else setState(result); });
    return () => { alive = false; };
  }, [router]);
  return <LockedHelpShell title="Trợ giúp tài khoản bị khóa">{state === "expired" ? <ExpiredHelpLink /> : state === "ended"
    ? <StatusBanner><p>Phiên đã kết thúc.</p><a className="underline" href="/help">Trung tâm trợ giúp</a></StatusBanner>
    : <StatusBanner>Đang kiểm tra liên kết…</StatusBanner>}</LockedHelpShell>;
}
