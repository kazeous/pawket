"use client";
import { useRef, useState } from "react";
import { caseErrorText, casePost, caseRequest } from "../cases/case-client";
import { TipRequestError } from "../tips/tip-client";
export function useOwnerCommand(actorUserId: string, onSuccess: () => Promise<void>) {
  const attempt = useRef<{ path: string; init: RequestInit } | null>(null); const inFlight = useRef(false);
  const [working, setWorking] = useState(false); const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  async function send() {
    if (inFlight.current || !attempt.current) return;
    inFlight.current = true; setWorking(true); setNotice(null);
    try {
      await caseRequest(attempt.current.path, attempt.current.init); await onSuccess(); attempt.current = null; setPending(false);
      setNotice({ tone: "success", text: "Đã ghi nhận thao tác. Trạng thái hiện tại đã được tải lại." });
    } catch (error) {
      const raw = error instanceof TipRequestError ? error.code : "dependency_unavailable";
      const code = raw === "IDENTITY_UNAVAILABLE" ? "dependency_unavailable" : raw;
      setNotice({ tone: "error", text: caseErrorText(code) });
      if (code !== "dependency_unavailable") { attempt.current = null; setPending(false); }
    } finally { inFlight.current = false; setWorking(false); }
  }
  function submit(path: string, payload: unknown) {
    if (inFlight.current || attempt.current) return;
    attempt.current = { path, init: casePost(payload, actorUserId) }; setPending(true); void send();
  }
  return { disabled: pending || working, working, pending, notice, submit, retry: () => void send() };
}
