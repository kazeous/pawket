"use client";

import { QRCodeSVG } from "qrcode.react";

export default function TipQr({ payload }: Readonly<{ payload: string }>) {
  return <QRCodeSVG value={payload} size={240} level="M" marginSize={4}
    title="VietQR chuyển khoản trực tiếp cho nghệ sĩ" role="img" className="h-auto max-w-full" />;
}
