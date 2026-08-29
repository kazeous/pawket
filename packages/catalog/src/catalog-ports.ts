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

export type MediaCatalogPort = {
  resolveReadyAssets(
    db: PawketDatabase | PawketTransaction,
    ownerUserId: string,
    references: readonly MediaReference[],
  ): Promise<ReadonlyMap<string, ReadyMedia>>;
};

export type VisibilityReadPort = {
  readHolds(
    db: PawketDatabase | PawketTransaction,
    pageId: string,
    revisionId: string,
    showcaseIds: readonly string[],
  ): Promise<{ pageHeld: boolean; heldShowcaseIds: ReadonlySet<string> }>;
};
