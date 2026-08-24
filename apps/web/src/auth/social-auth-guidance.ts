type SafeSocialAuthError =
  | "account_not_linked"
  | "email_not_found"
  | "unable_to_create_user"
  | "account_already_linked_to_different_user"
  | "social";

const SAFE_ERRORS = new Set<SafeSocialAuthError>([
  "account_not_linked",
  "email_not_found",
  "unable_to_create_user",
  "account_already_linked_to_different_user",
  "social",
]);

export function safeSocialAuthError(
  value: string | string[] | undefined,
): SafeSocialAuthError | null {
  if (!value) return null;
  if (Array.isArray(value)) return value.length > 0 ? "social" : null;
  const normalized = value.trim().toLowerCase();
  return SAFE_ERRORS.has(normalized as SafeSocialAuthError)
    ? (normalized as SafeSocialAuthError)
    : "social";
}

export function socialAuthGuidance(value: string | string[] | undefined): string | null {
  switch (safeSocialAuthError(value)) {
    case "account_not_linked":
      return "This email already belongs to a Pawket account. Sign in with your existing method, then explicitly link this provider from Security settings.";
    case "email_not_found":
      return "The provider did not return an email address. Add an email with the provider and try again.";
    case "unable_to_create_user":
      return "Pawket could not accept this provider identity. Confirm that its email is verified, then try again.";
    case "account_already_linked_to_different_user":
      return "This provider identity is already linked to another Pawket account.";
    case "social":
      return "Social authentication could not be completed. Please try again.";
    case null:
      return null;
  }
}
