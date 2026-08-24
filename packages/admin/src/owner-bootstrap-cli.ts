export type OwnerBootstrapCliArguments =
  | { help: true }
  | { help: false; userId: string; confirmation: string; applicationRevision: string };

export const ownerBootstrapUsage = [
  "Usage: pnpm bootstrap:owner -- --user-id=<exact-user-id> --revision=<APP_REVISION> --confirm=<confirmation>",
  "Confirmation format: BOOTSTRAP_OWNER:<exact-user-id>",
].join("\n");

export function parseOwnerBootstrapArguments(args: readonly string[]): OwnerBootstrapCliArguments {
  const forwardedArgs = args.filter((argument) => argument !== "--");
  if (forwardedArgs.includes("--help") || forwardedArgs.includes("-h")) return { help: true };

  const values = new Map<string, string>();
  for (const argument of forwardedArgs) {
    const separator = argument.indexOf("=");
    if (separator <= 2 || !argument.startsWith("--")) {
      throw new Error("INVALID_BOOTSTRAP_ARGUMENTS");
    }
    const key = argument.slice(2, separator);
    const value = argument.slice(separator + 1);
    if ((key !== "user-id" && key !== "revision" && key !== "confirm") || values.has(key) || !value) {
      throw new Error("INVALID_BOOTSTRAP_ARGUMENTS");
    }
    values.set(key, value);
  }

  const userId = values.get("user-id");
  const applicationRevision = values.get("revision");
  const confirmation = values.get("confirm");
  if (!userId || !applicationRevision || !confirmation) {
    throw new Error("INVALID_BOOTSTRAP_ARGUMENTS");
  }
  return { help: false, userId, applicationRevision, confirmation };
}
