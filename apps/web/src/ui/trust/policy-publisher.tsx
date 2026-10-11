"use client";
import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { FieldGroup } from "@/components/ui/field";
import { Field } from "../field";
import { LoadingState, RetryState } from "../async-state";
import { StatusBanner } from "../status-banner";
import { caseRequest, readCase, formatTipTime, caseErrorText } from "../cases/case-client";
import { ownerPoliciesSchema, policyKindLabels, ownerText, type OwnerPolicy } from "./owner-trust-client";
import { useOwnerCommand } from "./use-owner-command";
export function PolicyPublisher({ actorUserId, enforcementEnabled, initialPolicies }: Readonly<{ actorUserId: string; enforcementEnabled: boolean; initialPolicies?: OwnerPolicy[] }>) {
  const [policies, setPolicies] = useState(initialPolicies ?? []); const [loading, setLoading] = useState(initialPolicies === undefined); const [error, setError] = useState(false);
  const load = useCallback(async () => { setLoading(true); setError(false); try { setPolicies(readCase(ownerPoliciesSchema, await caseRequest("/api/v1/admin/policies")).policies); } catch { setError(true); } finally { setLoading(false); } }, []);
  const command = useOwnerCommand(actorUserId, load, (code) => code === "version_conflict" ? "Chính sách đã có phiên bản mới. Tải lại trang rồi thử lại." : caseErrorText(code));
  useEffect(() => { if (initialPolicies !== undefined) return; const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [initialPolicies, load]);
  return <div className="owner-workspace stack">{command.notice ? <StatusBanner tone={command.notice.tone}><p>{command.notice.text}</p></StatusBanner> : null}
    {command.pending && !command.working ? <Button variant="outline" onClick={command.retry}>Kiểm tra lại cùng yêu cầu</Button> : null}
    {!enforcementEnabled ? <p>Xuất bản chính sách đang tạm đóng.</p> : null}
    {loading ? <LoadingState label="Đang tải chính sách…" /> : error ? <RetryState title="Chưa tải được chính sách" onRetry={() => void load()} /> : policies.map((policy) => <PolicyForm key={`${policy.kind}-${policy.current?.revisionNumber ?? 0}`} policy={policy} disabled={command.disabled} enforcementEnabled={enforcementEnabled}
      onSubmit={(document) => command.submit("/api/v1/admin/policies", { kind: policy.kind, expectedRevisionNumber: policy.current?.revisionNumber ?? 0, document })} />)}
    <Button variant="outline" disabled={command.disabled || loading} onClick={() => void load()}>Tải lại chính sách</Button></div>;
}
function PolicyForm({ policy, disabled, enforcementEnabled, onSubmit }: Readonly<{ policy: OwnerPolicy; disabled: boolean; enforcementEnabled: boolean; onSubmit(document: string): void }>) {
  const id = useId(); const [error, setError] = useState<string | null>(null);
  function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); if (disabled || !enforcementEnabled) return; const document = ownerText(new FormData(event.currentTarget).get("document"), 16_000); if (!document) { setError("Nhập nội dung chính sách 1–16.000 ký tự."); return; } setError(null); onSubmit(document); }
  return <section className="work-surface stack"><h2>{policyKindLabels[policy.kind]}</h2>{policy.current ? <p>Phiên bản hiện tại: {policy.current.revisionNumber} · Có hiệu lực <time dateTime={policy.current.effectiveAt}>{formatTipTime(policy.current.effectiveAt)}</time></p> : <p>Chưa có phiên bản được xuất bản.</p>}
    <form className="stack" onSubmit={submit}><FieldGroup><Field htmlFor={id} label="Nội dung chính sách" required error={error} hint="Tối đa 16.000 ký tự. Xuất bản cần xác thực lại owner."><Textarea id={id} name="document" required defaultValue={policy.current?.document ?? ""} readOnly={!enforcementEnabled} disabled={disabled} /></Field></FieldGroup>{enforcementEnabled ? <Button type="submit" disabled={disabled}>Xuất bản</Button> : null}</form></section>;
}
