import type { PawketDatabase, PawketTransaction } from "@pawket/database";

export type CreatorSeed = Readonly<{
  userId: string;
  capabilityState: "active" | "suspended";
  capabilityVersion: number;
  approvedRevisionId: string;
  displayName: string;
  introduction: string;
}>;

export type IdentityCreatorSeedPort = {
  getCreatorSeed(
    db: PawketDatabase | PawketTransaction,
    userId: string,
  ): Promise<CreatorSeed | null>;
  getCreatorSeeds(
    db: PawketDatabase | PawketTransaction,
    userIds: readonly string[],
  ): Promise<ReadonlyMap<string, CreatorSeed | null>>;
};

export type MediaReference = Readonly<{
  assetId: string;
  purpose: "avatar" | "cover" | "showcase";
  altText: string | null;
}>;

export type ReadyMediaDerivative = Readonly<{
  derivativeId: string;
  width: number;
  height: number;
}>;

export type ReadyMedia = Readonly<{
  assetId: string;
  ownerUserId: string;
  purpose: MediaReference["purpose"];
  derivatives: Readonly<Record<"thumb" | "display" | "large", ReadyMediaDerivative>>;
}>;
export type OwnedMedia = Readonly<{
  assetId: string;
  ownerUserId: string;
  purpose: MediaReference["purpose"];
  state: "awaiting_upload" | "pending" | "processing" | "ready" | "failed";
  derivatives: Partial<ReadyMedia["derivatives"]>;
}>;

export type MediaCatalogPort = {
  resolveOwnedAssets?(
    db: PawketDatabase | PawketTransaction,
    ownerUserId: string,
    references: readonly MediaReference[],
  ): Promise<ReadonlyMap<string, OwnedMedia>>;
  resolveReadyAssets(
    db: PawketDatabase | PawketTransaction,
    ownerUserId: string,
    references: readonly MediaReference[],
  ): Promise<ReadonlyMap<string, ReadyMedia>>;
  resolveReadyAssetsBatch(
    db: PawketDatabase | PawketTransaction,
    requests: readonly Readonly<{ ownerUserId: string; references: readonly MediaReference[] }>[],
  ): Promise<ReadonlyMap<string, ReadonlyMap<string, ReadyMedia>>>;
};

export type VisibilityHoldRequest = Readonly<{
  pageId: string;
  revisionId: string;
  showcaseIds: readonly string[];
}>;

export type VisibilityHoldSnapshot = Readonly<{
  pageHeld: boolean;
  heldShowcaseIds: ReadonlySet<string>;
}>;

export type VisibilityReadPort = {
  readHolds(
    db: PawketDatabase | PawketTransaction,
    pageId: string,
    revisionId: string,
    showcaseIds: readonly string[],
  ): Promise<{ pageHeld: boolean; heldShowcaseIds: ReadonlySet<string> }>;
  readHoldsBatch(
    db: PawketDatabase | PawketTransaction,
    requests: readonly VisibilityHoldRequest[],
  ): Promise<ReadonlyMap<string, VisibilityHoldSnapshot>>;
};
