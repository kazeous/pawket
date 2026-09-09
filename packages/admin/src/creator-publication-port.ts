import type { PawketTransaction } from "@pawket/database";

export type CatalogCapabilityTransitionPort = Readonly<{
  apply(
    tx: PawketTransaction,
    input: {
      creatorUserId: string;
      action: "suspend" | "reinstate";
      actorUserId: string;
      actorSessionId: string;
      reasonCode: string;
      requestId: string;
      occurredAt: Date;
    },
  ): Promise<{ pageId: string | null; previousPublishedRevisionId: string | null }>;
}>;

type CatalogSuspensionCommand = Readonly<{
  clearPublishedHeadForSuspension(
    tx: PawketTransaction,
    input: {
      creatorUserId: string;
      actorUserId: string;
      actorSessionId: string;
      reasonCode: string;
      requestId: string;
      occurredAt: Date;
    },
  ): Promise<{ pageId: string | null; previousPublishedRevisionId: string | null }>;
}>;

export function createCatalogCapabilityTransitionPort(
  catalog: CatalogSuspensionCommand,
): CatalogCapabilityTransitionPort {
  return {
    async apply(tx, transition) {
      const result = await catalog.clearPublishedHeadForSuspension(tx, {
        creatorUserId: transition.creatorUserId,
        actorUserId: transition.actorUserId,
        actorSessionId: transition.actorSessionId,
        reasonCode: transition.reasonCode,
        requestId: transition.requestId,
        occurredAt: transition.occurredAt,
      });
      if (transition.action === "reinstate" && result.previousPublishedRevisionId !== null) {
        throw new Error("Catalog publication head must remain clear during reinstatement");
      }
      return result;
    },
  };
}
