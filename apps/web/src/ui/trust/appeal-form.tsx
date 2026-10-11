"use client";
import { useId, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { TrustCommandFeedback, useTrustCommand } from "./trust-command";
import { parseCommission } from "../commissions/commission-client";
import { appealInputSchema, appealResultSchema, type AppealTarget } from "./trust-client";

export function AppealForm({ target, onSubmitted, disabled = false }: Readonly<{ target: AppealTarget; onSubmitted(): void; disabled?: boolean }>) {
  const id = useId(); const command = useTrustCommand(); const router = useRouter(); const [invalid, setInvalid] = useState(false); const locked = disabled || command.locked;
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (locked) return;
    const input = appealInputSchema.safeParse({ target, statement: new FormData(event.currentTarget).get("statement") });
    setInvalid(!input.success); if (!input.success) return;
    command.execute("/api/v1/help/appeals", input.data, (value) => { parseCommission(appealResultSchema, value); onSubmitted(); router.refresh(); });
  }
  return <form aria-label="Gửi kháng nghị" onSubmit={submit}><FieldGroup><TrustCommandFeedback command={command} />
    <Field data-disabled={locked || undefined} data-invalid={invalid || undefined}><FieldLabel htmlFor={`${id}-statement`}>Trình bày kháng nghị</FieldLabel>
      <Textarea id={`${id}-statement`} name="statement" required maxLength={8000} disabled={locked} aria-invalid={invalid || undefined} aria-describedby={`${id}-note${invalid ? ` ${id}-error` : ""}`} />
      <FieldDescription id={`${id}-note`}>Bạn chỉ được kháng nghị một lần, trong 14 ngày. Biện pháp vẫn có hiệu lực trong lúc Pawket xem xét.</FieldDescription>
      {invalid ? <FieldError id={`${id}-error`}>Trình bày cần 1–4.000 ký tự hợp lệ.</FieldError> : null}
    </Field><Button type="submit" className="self-start" disabled={locked}>Gửi kháng nghị</Button>
  </FieldGroup></form>;
}
