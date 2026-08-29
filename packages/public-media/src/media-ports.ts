import type { PawketDatabase, PawketTransaction } from "@pawket/database";

export type CatalogMediaVisibilityPort = Readonly<{
  isDerivativePublic(db: PawketDatabase | PawketTransaction, assetId: string, variant: "thumb" | "display" | "large"): Promise<boolean>;
  isDerivativePreviewable(db: PawketDatabase | PawketTransaction, actorUserId: string, assetId: string, variant: "thumb" | "display" | "large"): Promise<boolean>;
}>;

export type PublicMediaRetentionHoldPort = Readonly<{
  protectedAssetIds(db: PawketDatabase | PawketTransaction, assetIds: readonly string[]): Promise<ReadonlySet<string>>;
}>;
