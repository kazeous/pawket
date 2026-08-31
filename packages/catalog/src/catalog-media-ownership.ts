import {
  creatorPageDrafts,
  creatorPages,
  creatorShowcaseDraftMedia,
  creatorShowcaseDrafts,
  type PawketDatabase,
  type PawketTransaction,
} from "@pawket/database";
import { and, eq, isNull } from "drizzle-orm";

type MediaPurpose = "avatar" | "cover" | "showcase";

export type CatalogMediaOwnershipPort = Readonly<{
  ownsAsset(
    db: PawketDatabase | PawketTransaction,
    ownerUserId: string,
    assetId: string,
    purpose: MediaPurpose,
  ): Promise<boolean>;
}>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ACTOR_ID = /^[A-Za-z0-9._:-]{1,200}$/u;

export function createCatalogMediaOwnershipPort(): CatalogMediaOwnershipPort {
  return {
    async ownsAsset(db, ownerUserId, assetId, purpose) {
      if (!ACTOR_ID.test(ownerUserId) || !UUID.test(assetId)) return false;
      if (purpose === "avatar" || purpose === "cover") {
        const assetColumn = purpose === "avatar"
          ? creatorPageDrafts.avatarAssetId
          : creatorPageDrafts.coverAssetId;
        const [relationship] = await db.select({ pageId: creatorPages.id })
          .from(creatorPages)
          .innerJoin(creatorPageDrafts, eq(creatorPageDrafts.pageId, creatorPages.id))
          .where(and(eq(creatorPages.userId, ownerUserId), eq(assetColumn, assetId)))
          .limit(1);
        return Boolean(relationship);
      }
      if (purpose !== "showcase") return false;
      const [relationship] = await db.select({ pageId: creatorPages.id })
        .from(creatorPages)
        .innerJoin(creatorShowcaseDrafts, eq(creatorShowcaseDrafts.pageId, creatorPages.id))
        .innerJoin(creatorShowcaseDraftMedia, eq(creatorShowcaseDraftMedia.showcaseId, creatorShowcaseDrafts.id))
        .where(and(
          eq(creatorPages.userId, ownerUserId),
          eq(creatorShowcaseDraftMedia.assetId, assetId),
          isNull(creatorShowcaseDrafts.removedAt),
        ))
        .limit(1);
      return Boolean(relationship);
    },
  };
}
