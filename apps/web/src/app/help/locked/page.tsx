"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ExpiredHelpLink, LockedHelpShell } from "@/ui/trust/locked-help-shell";
import { StatusBanner } from "@/ui/status-banner";

type ExchangeResult = "accepted" | "expired" | "ended";

export default function LockedHelpPage() {
  const router = useRouter(); const exchange = useRef<Promise<ExchangeResult> | null>(null);
  const exchangedTokens = useRef(new Set<string>());
  const [state, setState] = useState<"checking" | "expired" | "ended">("checking");
  useEffect(() => {
    let alive = true;
    const observe = (pending: Promise<ExchangeResult>) => {
      void pending.then((result) => {
        if (!alive || exchange.current !== pending) return;
        if (result === "accepted") router.replace("/help/locked/case"); else setState(result);
      });
    };
    const exchangeFragment = () => {
      const fragment = window.location.hash;
      window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
      const values = new URLSearchParams(fragment.slice(1)); const token = values.get("t");
      if (!fragment && new URLSearchParams(window.location.search).get("ended") === "1") exchange.current = Promise.resolve("ended");
      else if ([...values.keys()].length !== 1 || !token || !/^[A-Za-z0-9_-]{43}$/u.test(token)) exchange.current = Promise.resolve("expired");
      else {
        // Record before posting so StrictMode and repeated hashchanges cannot exchange a token twice.
        if (exchangedTokens.current.has(token)) return;
        exchangedTokens.current.add(token);
        exchange.current = (async () => {
          try {
            const response = await fetch("/help/locked/session", { method: "POST", credentials: "same-origin", cache: "no-store",
              headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
            return response.status === 204 ? "accepted" : "expired";
          } catch { return "expired"; }
        })();
      }
      observe(exchange.current);
    };
    const onHashChange = () => { if (window.location.hash) exchangeFragment(); };
    window.addEventListener("hashchange", onHashChange);
    if (window.location.hash || !exchange.current) exchangeFragment(); else observe(exchange.current);
    return () => { alive = false; window.removeEventListener("hashchange", onHashChange); };
  }, [router]);
  return <LockedHelpShell title="Trợ giúp tài khoản bị khóa">{state === "expired" ? <ExpiredHelpLink /> : state === "ended"
    ? <StatusBanner><p>Phiên đã kết thúc.</p><a className="underline" href="/help">Trung tâm trợ giúp</a></StatusBanner>
    : <StatusBanner>Đang kiểm tra liên kết…</StatusBanner>}</LockedHelpShell>;
}
