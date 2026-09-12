import { describe, expect, it } from "vitest";

import { type IntegerVnd, requireIntegerVnd } from "../src/tip-contracts.js";
import {
  createVietQrTransferInstruction, isVietQrDestinationSupported, VIETQR_MAX_AMOUNT_VND,
  VIETQR_RECEIVING_BANKS, vietQrCrc16, VietQrError, type VietQrTransferInput,
} from "../src/vietqr.js";
import golden from "./fixtures/vietqr-synthetic-golden.json" with { type: "json" };

// Public institutional example, not a creator/buyer transaction. Documentation
// read 2026-09-12; no QR generation endpoint or transfer was invoked.
// https://www.vietqr.io/danh-sach-api/link-tao-ma-nhanh/api-tao-ma-qr/
const providerExample = {
  bankBin: "970415", accountNumber: "113366668888",
  amountVnd: requireIntegerVnd(79_000), transferReference: "Ung Ho Quy Vac Xin",
};
const providerPayload = "00020101021238560010A0000007270126000697041501121133666688880208QRIBFTTA53037045405790005802VN62220818Ung Ho Quy Vac Xin63043ACF";

// Synthetic account/reference for every other generated instruction.
const synthetic: VietQrTransferInput = {
  bankBin: "970436", accountNumber: "0000001234567",
  amountVnd: requireIntegerVnd(50_000), transferReference: "PWTEST000000000000000001",
};

// Test-only structural decoder, independent of the encoder's concatenation.
function fields(payload: string): Map<string, string> {
  const result = new Map<string, string>();
  let offset = 0;
  while (offset < payload.length) {
    const header = payload.slice(offset, offset + 4);
    if (!/^[0-9]{4}$/u.test(header)) throw new Error("Invalid TLV header");
    const id = header.slice(0, 2);
    const length = Number(header.slice(2));
    if (!length || offset + 4 + length > payload.length || result.has(id)) throw new Error("Invalid TLV length/id");
    result.set(id, payload.slice(offset + 4, offset + 4 + length));
    offset += 4 + length;
  }
  return result;
}

describe("local domestic VietQR contract", () => {
  it.each(golden.vectors)("matches independently checked synthetic golden $transferReference", (vector) => {
    const { payload, ...input } = vector;
    const instruction = createVietQrTransferInstruction({ ...input, amountVnd: requireIntegerVnd(input.amountVnd) });
    expect(instruction.payload).toBe(payload);
    expect(fields(payload).get("63")).toMatch(/^[0-9A-F]{4}$/u);
  });

  it("matches the complete dated provider golden vector", () => {
    expect(createVietQrTransferInstruction(providerExample).payload).toBe(providerPayload);
  });

  it("matches the original NAPAS public v1.0 §6.1.3 CRC vector", () => {
    // Original September 2021 PDF pp.31–32, contains both bill and purpose.
    // Our narrower encoder emits only purpose; the CRC algorithm covers both.
    const data = "00020101021238570010A00000072701270006970403011300110123456780208QRIBFTTA530370454061800005802VN62340107NPS68690819thanh toan don hang6304";
    expect(vietQrCrc16(new TextEncoder().encode(data))).toBe("2E2E");
    expect(vietQrCrc16(new TextEncoder().encode("123456789"))).toBe("29B1");
    expect(vietQrCrc16(new Uint8Array())).toBe("FFFF");
  });

  it("detects corrupted data, missing CRC header and reordered fields against the published checksum", () => {
    const data = providerPayload.slice(0, -4);
    for (const corrupted of [data.replace("79000", "79001"), data.slice(0, -4), data.replace("5303704540579000", "5405790005303704")]) {
      expect(vietQrCrc16(new TextEncoder().encode(corrupted))).not.toBe("3ACF");
    }
  });

  it("emits the exact nested account, amount and purpose with no extra personal fields", () => {
    const instruction = createVietQrTransferInstruction(synthetic);
    const root = fields(instruction.payload);
    expect([...root.keys()]).toEqual(["00", "01", "38", "53", "54", "58", "62", "63"]);
    expect(root.get("00")).toBe("01");
    expect(root.get("01")).toBe("12");
    expect(root.get("53")).toBe("704");
    expect(root.get("54")).toBe("50000");
    expect(root.get("58")).toBe("VN");
    const account = fields(root.get("38")!);
    expect([...account]).toEqual([
      ["00", "A000000727"], ["01", "000697043601130000001234567"], ["02", "QRIBFTTA"],
    ]);
    expect(fields(account.get("01")!).get("01")).toBe(synthetic.accountNumber);
    expect([...fields(root.get("62")!)]).toEqual([["08", synthetic.transferReference]]);
    expect(instruction).toEqual({ ...synthetic, bankName: "Vietcombank", currency: "VND", payload: instruction.payload });
    expect(Object.isFrozen(instruction)).toBe(true);
    expect(createVietQrTransferInstruction(synthetic)).toEqual(instruction);
  });

  it("preserves normalization and leading zeros at account boundaries", () => {
    for (const accountNumber of ["000001", "0000001234567", "0000000000000000001"]) {
      const result = createVietQrTransferInstruction({ ...synthetic, accountNumber });
      const bank = fields(fields(result.payload).get("38")!);
      expect(fields(bank.get("01")!).get("01")).toBe(accountNumber);
      expect(result.accountNumber).toBe(accountNumber);
    }
  });

  it("encodes format and product maximums without decimal, exponent or separators", () => {
    for (const amount of [1, 10_000, 5_000_000, VIETQR_MAX_AMOUNT_VND]) {
      const result = createVietQrTransferInstruction({ ...synthetic, amountVnd: requireIntegerVnd(amount) });
      expect(fields(result.payload).get("54")).toBe(String(amount));
      expect(result.amountVnd).toBe(amount);
    }
  });

  it.each(["A", "PW0123456789ABCDEFGHIJKLM", "One Two 3"])("preserves bounded ASCII reference %s", (transferReference) => {
    const result = createVietQrTransferInstruction({ ...synthetic, transferReference });
    expect(fields(fields(result.payload).get("62")!).get("08")).toBe(transferReference);
    expect(result.transferReference).toBe(transferReference);
  });

  it.each(["", "A".repeat(26), " PW1", "PW1 ", "PW1\n", "PW1\r\n", "PW  1", "PW\n1", "PW\t1", "PẂ1", "PW💰1", "PW-1", "***", "PW\u00001"])("rejects noncanonical reference %j without rewriting it", (transferReference) => {
    expect(() => createVietQrTransferInstruction({ ...synthetic, transferReference })).toThrow(new VietQrError("invalid_reference"));
  });

  it.each(["", "12345", "1".repeat(20), " 000001", "000001 ", "000001\n", "000001\r\n", "000 001", "000-001", "12345A", "１２３４５６"])("rejects unsupported account %j", (accountNumber) => {
    expect(isVietQrDestinationSupported({ ...synthetic, accountNumber })).toBe(false);
    expect(() => createVietQrTransferInstruction({ ...synthetic, accountNumber })).toThrow(new VietQrError("invalid_account"));
  });

  it.each(["000000", "970403", "971025", "999999", " 970436", "970436 ", "97043", "toString", "__proto__"])("fails closed for bank %j outside the reviewed product registry", (bankBin) => {
    expect(isVietQrDestinationSupported({ ...synthetic, bankBin })).toBe(false);
    expect(() => createVietQrTransferInstruction({ ...synthetic, bankBin })).toThrow(new VietQrError("unsupported_bank"));
  });

  it.each([0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER, VIETQR_MAX_AMOUNT_VND + 1, "50000", null, undefined])("runtime-validates amount %j even when the branded type is bypassed", (amount) => {
    expect(() => createVietQrTransferInstruction({ ...synthetic, amountVnd: amount as IntegerVnd })).toThrow(new VietQrError("invalid_amount"));
  });

  it("does not emit raw input in errors or permit unreviewed registry mutation", () => {
    expect(Object.isFrozen(VIETQR_RECEIVING_BANKS)).toBe(true);
    expect(Object.keys(VIETQR_RECEIVING_BANKS)).toEqual(["970415", "970436"]);
    try {
      createVietQrTransferInstruction({ ...synthetic, accountNumber: "sensitive invalid destination" });
      throw new Error("Expected validation error");
    } catch (error) {
      expect(error).toBeInstanceOf(VietQrError);
      expect(String(error)).toBe("VietQrError: invalid_account");
      expect(JSON.stringify(error)).not.toContain("sensitive");
    }
  });
});
