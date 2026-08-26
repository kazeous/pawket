export function totpSecretFromURI(totpURI: string): string | null {
  try {
    const uri = new URL(totpURI);
    const secret = uri.protocol === "otpauth:" ? uri.searchParams.get("secret") : null;
    return secret && /^[A-Z2-7]+$/iu.test(secret) ? secret.toUpperCase() : null;
  } catch {
    return null;
  }
}

export function groupedTotpSecret(secret: string): string {
  return secret.match(/.{1,4}/gu)?.join(" ") ?? secret;
}
