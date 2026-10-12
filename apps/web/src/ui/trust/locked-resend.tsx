"use client";
import { useId, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { StatusBanner } from "@/ui/status-banner";

export function LockedResend() {
  const id = useId(); const running = useRef(false); const [pending, setPending] = useState(false); const [sent, setSent] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (running.current) return;
    const email = new FormData(event.currentTarget).get("email"); if (typeof email !== "string") return;
    running.current = true; setPending(true);
    try { await fetch("/help/locked/link-request", { method: "POST", credentials: "same-origin", cache: "no-store",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) }); }
    catch { /* A resend never discloses an address-specific outcome. */ }
    finally { running.current = false; setPending(false); setSent(true); }
  }
  return <form aria-label="Yêu cầu liên kết mới" onSubmit={submit}><FieldGroup>
    {sent ? <StatusBanner>Nếu email này thuộc một tài khoản đang bị khóa, Pawket đã gửi liên kết mới.</StatusBanner> : null}
    <Field data-disabled={pending || undefined}><FieldLabel htmlFor={`${id}-email`}>Email</FieldLabel><Input id={`${id}-email`} name="email" type="email" autoComplete="email" required maxLength={512} disabled={pending} /></Field>
    <Button type="submit" className="self-start" disabled={pending}>{pending ? "Đang gửi…" : "Gửi liên kết mới"}</Button>
  </FieldGroup></form>;
}
