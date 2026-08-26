import { describe, expect, test } from "vitest";

import {
  groupedTotpSecret,
  totpSecretFromURI,
} from "../src/app/settings/security/totp-enrollment.js";

describe("TOTP enrollment presentation", () => {
  test("extracts only a valid Base32 secret from an otpauth URI", () => {
    const uri = "otpauth://totp/Pawket:artist%40example.com?secret=abcdefghijklmnop&issuer=Pawket";

    expect(totpSecretFromURI(uri)).toBe("ABCDEFGHIJKLMNOP");
    expect(groupedTotpSecret(totpSecretFromURI(uri)!)).toBe("ABCD EFGH IJKL MNOP");
    expect(totpSecretFromURI("https://example.com/?secret=ABCDEFGHIJKLMNOP")).toBeNull();
    expect(totpSecretFromURI("otpauth://totp/Pawket?secret=not-valid-0")).toBeNull();
  });
});
