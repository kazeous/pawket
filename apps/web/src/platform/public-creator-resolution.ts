import type { PublicCreatorResolution } from "@pawket/catalog";
import { recordCreatorDirectoryResolution } from "@pawket/observability";

type PublicCreatorQuery = Readonly<{
  resolvePublicCreator(handle: string): Promise<PublicCreatorResolution>;
}>;

export async function resolvePublicCreatorWithMetric(
  query: PublicCreatorQuery,
  handle: string,
): Promise<PublicCreatorResolution> {
  const result = await query.resolvePublicCreator(handle);
  recordCreatorDirectoryResolution(
    result.kind === "visible"
      ? { source: "canonical", outcome: "succeeded" }
      : result.kind === "redirect"
        ? { source: "alias", outcome: "succeeded" }
        : { source: "unknown", outcome: "rejected" },
  );
  return result;
}
