import type { PawketDatabase, PawketTransaction } from "@pawket/database";

export type ReportTarget = Readonly<{
  targetType: "page" | "showcase";
  targetId: string;
  publicationRevisionId: string;
}>;

export type ModerationTargetSnapshot = Readonly<{
  target: ReportTarget;
  pageId: string;
  creatorUserId: string;
  canonicalHandle: string;
  displayName: string;
  showcaseTitle: string | null;
  mediaAssetIds: readonly string[];
}>;

export type CatalogModerationSnapshotPort = Readonly<{
  resolveVisibleReportTarget(
    db: PawketDatabase | PawketTransaction,
    target: ReportTarget,
  ): Promise<ModerationTargetSnapshot | null>;
  readRevisionTarget(
    db: PawketDatabase | PawketTransaction,
    target: ReportTarget,
  ): Promise<ModerationTargetSnapshot | null>;
}>;
