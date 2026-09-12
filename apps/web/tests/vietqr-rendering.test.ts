import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QRCodeSVG } from "qrcode.react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { requireIntegerVnd } from "../../../packages/payments/src/tip-contracts.js";
import { createVietQrTransferInstruction } from "../../../packages/payments/src/vietqr.js";
import golden from "../../../packages/payments/tests/fixtures/vietqr-synthetic-golden.json";

afterEach(() => vi.unstubAllGlobals());

describe("VietQR local renderer contract", () => {
  it.each(golden.vectors)("renders synthetic $transferReference deterministically without a network service", (vector) => {
    const fetch = vi.fn(() => { throw new Error("QR rendering must be local"); });
    vi.stubGlobal("fetch", fetch);
    const instruction = createVietQrTransferInstruction({ ...vector, amountVnd: requireIntegerVnd(vector.amountVnd) });
    const render = () => renderToStaticMarkup(createElement(QRCodeSVG, {
      value: instruction.payload, size: 256, level: "M", marginSize: 4,
      bgColor: "#FFFFFF", fgColor: "#000000", title: "Mã chuyển khoản thử nghiệm",
    }));
    const svg = render();
    expect(render()).toBe(svg);
    expect(svg).toMatch(/^<svg /u);
    expect(svg).toContain("<title>Mã chuyển khoản thử nghiệm</title>");
    expect(svg).toContain('<path fill="#000000"');
    expect(svg).not.toMatch(/<(?:image|script|foreignObject)\b|\b(?:href|src)=/u);
    expect(fetch).not.toHaveBeenCalled();
    // The Payments projection independently supplies the exact text facts.
    // Actual screen fallback/error-boundary interaction is covered in Task 9.
    const { payload, ...textFacts } = instruction;
    expect(payload).toBe(vector.payload);
    expect(textFacts).toEqual({
      bankBin: vector.bankBin, bankName: vector.bankBin === "970415" ? "VietinBank" : "Vietcombank",
      accountNumber: vector.accountNumber, amountVnd: vector.amountVnd,
      transferReference: vector.transferReference, currency: "VND",
    });
  });
});
