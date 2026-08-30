import type { PawketDatabase, PawketTransaction } from "@pawket/database";

/** Consumer-owned identity capability used to authorize creator mutations. */
export type CreatorCapability = Readonly<{ userId: string; state: "active" }>;
export type CreatorCapabilityPort = Readonly<{
  getActiveCreator(db: PawketDatabase | PawketTransaction, userId: string): Promise<CreatorCapability | null>;
}>;

export type CatalogMediaVisibilityPort = Readonly<{
  isDerivativePublic(db: PawketDatabase | PawketTransaction, assetId: string, variant: "thumb" | "display" | "large"): Promise<boolean>;
  isDerivativePreviewable(db: PawketDatabase | PawketTransaction, actorUserId: string, assetId: string, variant: "thumb" | "display" | "large"): Promise<boolean>;
}>;

/** Consumer-owned Catalog boundary used by private media commands. */
export type CatalogMediaOwnershipPort = Readonly<{
  ownsAsset(
    db: PawketDatabase | PawketTransaction,
    ownerUserId: string,
    assetId: string,
    purpose: "avatar" | "cover" | "showcase",
  ): Promise<boolean>;
}>;

export type PublicMediaRetentionHoldPort = Readonly<{
  protectedAssetIds(db: PawketDatabase | PawketTransaction, assetIds: readonly string[]): Promise<ReadonlySet<string>>;
}>;

/**
 * Authoritative operational control for destructive public-media retention.
 *
 * The current accepted revision is deliberately read without passing the
 * caller's configured reference, so a caller cannot authorize itself by
 * echoing two values it supplied.
 */
export type PublicMediaRetentionAcceptancePort = Readonly<{
  readCurrentAcceptedRevision(
    db: PawketDatabase | PawketTransaction,
  ): Promise<Readonly<{ acceptedRevision: string }> | null>;
}>;
