/** Only the server's opaque review reference may redirect a pending mutation. */
export function redirectToOidcReview(value: unknown): boolean {
  if (!value || typeof value !== "object" || !("code" in value) || value.code !== "OIDC_STEP_UP_REQUIRED" ||
    !("reviewPath" in value) || typeof value.reviewPath !== "string" ||
    !/^\/auth\/review\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value.reviewPath)) return false;
  window.location.assign(value.reviewPath); return true;
}
