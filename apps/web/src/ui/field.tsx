import { cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";

export function Field({ children, error, hint, htmlFor, label, required = false }: Readonly<{
  children: ReactNode;
  error?: string | null;
  hint?: string;
  htmlFor: string;
  label: string;
  required?: boolean;
}>) {
  const descriptionId = `${htmlFor}-description`;
  const element = children as ReactElement<{ "aria-describedby"?: string; "aria-invalid"?: boolean }>;
  const control = isValidElement(children)
    ? cloneElement(element, {
        "aria-describedby": [element.props["aria-describedby"], descriptionId].filter(Boolean).join(" "),
        "aria-invalid": error ? true : undefined,
      })
    : children;
  return (
    <div className="field" data-state={error ? "error" : "default"}>
      <label htmlFor={htmlFor}>{label}{required ? <span className="required-mark"> bắt buộc</span> : null}</label>
      {control}
      <p className="field-description" id={descriptionId}>{error ?? hint ?? "\u00a0"}</p>
    </div>
  );
}
