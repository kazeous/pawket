// One structured description per email feeds both the plain-text body and the
// HTML alternative, so the two parts of a multipart message cannot drift apart.
export type SecurityEmailContent = Readonly<{
  heading: string;
  paragraphs: readonly string[];
  detail?: Readonly<{ label: string; value: string }>;
  action?: Readonly<{ intro: string; label: string; url: string }>;
}>;

export function renderSecurityEmailText(content: SecurityEmailContent): string {
  const blocks = [content.heading, ...content.paragraphs];
  if (content.detail) blocks.push(`${content.detail.label}: ${content.detail.value}.`);
  if (content.action) blocks.push(`${content.action.intro}\n${content.action.url}`);
  return blocks.join("\n\n");
}

// Hex approximations of the oklch tokens in tokens.css; mail clients ignore oklch.
const palette = {
  paper: "#f5eee1",
  surface: "#fefbf6",
  ink: "#211912",
  neutral: "#47413a",
  muted: "#5d5750",
  rule: "#e4dccd",
  accent: "#025ac3",
  accentInk: "#fcf8f1",
  warmSoft: "#fdf1dc",
} as const;

const fontStack = "'Be Vietnam Pro', 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function paragraphHtml(text: string): string {
  return `<tr><td style="padding: 0 32px 16px; font-family: ${fontStack}; font-size: 15px; line-height: 1.6; color: ${palette.neutral};">${escapeHtml(text)}</td></tr>`;
}

function detailHtml(detail: NonNullable<SecurityEmailContent["detail"]>): string {
  return `<tr><td style="padding: 0 32px 16px;">
  <table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0" style="background-color: ${palette.warmSoft}; border-radius: 8px;">
    <tr><td style="padding: 14px 16px; font-family: ${fontStack};">
      <div style="font-size: 12px; line-height: 1.4; color: ${palette.muted}; text-transform: uppercase; letter-spacing: 0.04em;">${escapeHtml(detail.label)}</div>
      <div style="padding-top: 4px; font-size: 15px; line-height: 1.5; font-weight: bold; color: ${palette.ink};">${escapeHtml(detail.value)}</div>
    </td></tr>
  </table>
</td></tr>`;
}

function actionHtml(action: NonNullable<SecurityEmailContent["action"]>): string {
  const href = escapeHtml(action.url);
  // A colon-terminated intro only leads into the bare URL in plain text; the button replaces it.
  const intro = action.intro.endsWith(":") ? "" : paragraphHtml(action.intro);
  return `${intro}
<tr><td style="padding: 8px 32px 24px;">
  <a href="${href}" target="_blank" rel="noopener noreferrer" style="display: inline-block; padding: 12px 22px; background-color: ${palette.accent}; color: ${palette.accentInk}; font-family: ${fontStack}; font-size: 15px; font-weight: bold; line-height: 1.2; text-decoration: none; border-radius: 8px;">${escapeHtml(action.label)}</a>
</td></tr>
<tr><td style="padding: 0 32px 24px; font-family: ${fontStack}; font-size: 12px; line-height: 1.5; color: ${palette.muted};">
  Nếu nút không hoạt động, hãy sao chép đường dẫn này vào trình duyệt:<br><a href="${href}" target="_blank" rel="noopener noreferrer" style="color: ${palette.accent}; word-break: break-all; overflow-wrap: anywhere;">${href}</a>
</td></tr>`;
}

export function renderSecurityEmailHtml(appBaseUrl: string, content: SecurityEmailContent): string {
  const homeUrl = new URL("/", appBaseUrl);
  const home = escapeHtml(homeUrl.toString());
  const homeLabel = escapeHtml(homeUrl.host);
  const preheader = escapeHtml(content.paragraphs[0] ?? content.heading);

  return `<!DOCTYPE html>
<html lang="vi">
<head>
<meta http-equiv="Content-Type" content="text/html; charset=utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${escapeHtml(content.heading)}</title>
</head>
<body style="margin: 0; padding: 0; background-color: ${palette.paper}; -webkit-text-size-adjust: 100%;">
<div style="display: none; max-height: 0; overflow: hidden; opacity: 0; color: transparent;">${preheader}</div>
<table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0" style="background-color: ${palette.paper};">
  <tr><td align="center" style="padding: 32px 16px;">
    <table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0" style="max-width: 560px;">
      <tr><td style="padding: 0 8px 16px; font-family: ${fontStack}; font-size: 22px; font-weight: bold; letter-spacing: -0.02em; color: ${palette.ink};">Pawket<span style="color: ${palette.accent};">.</span></td></tr>
      <tr><td style="background-color: ${palette.surface}; border: 1px solid ${palette.rule}; border-top: 4px solid ${palette.accent}; border-radius: 12px;">
        <table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0">
          <tr><td style="padding: 32px 32px 16px; font-family: ${fontStack}; font-size: 22px; font-weight: bold; line-height: 1.3; color: ${palette.ink};"><h1 style="margin: 0; font-size: 22px; line-height: 1.3; font-weight: bold;">${escapeHtml(content.heading)}</h1></td></tr>
${content.paragraphs.map(paragraphHtml).join("\n")}
${content.detail ? detailHtml(content.detail) : ""}
${content.action ? actionHtml(content.action) : `<tr><td style="padding: 0 0 16px;"></td></tr>`}
        </table>
      </td></tr>
      <tr><td style="padding: 20px 8px 0; font-family: ${fontStack}; font-size: 12px; line-height: 1.6; color: ${palette.muted};">
        Email này được gửi tự động từ Pawket về tài khoản của bạn.<br>
        <a href="${home}" target="_blank" rel="noopener noreferrer" style="color: ${palette.muted}; text-decoration: underline;">${homeLabel}</a>
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>
`;
}
