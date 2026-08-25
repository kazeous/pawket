"use client";

import { useEffect, useRef } from "react";

export type FieldError = Readonly<{ fieldId: string; message: string }>;

export function FormErrorSummary({ errors, title = "Hãy kiểm tra lại thông tin" }: Readonly<{ errors: readonly FieldError[]; title?: string }>) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { if (errors.length > 0) ref.current?.focus(); }, [errors]);
  if (errors.length === 0) return null;
  return (
    <div className="error-summary" ref={ref} role="alert" tabIndex={-1}>
      <strong>{title}</strong>
      <ul>{errors.map((error) => <li key={error.fieldId}><a href={`#${error.fieldId}`}>{error.message}</a></li>)}</ul>
    </div>
  );
}
