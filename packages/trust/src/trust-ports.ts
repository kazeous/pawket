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
  /**
   * The implementation must acquire the creator-page visibility fence and
   * retain it through the caller's transaction commit. Catalog publish,
   * unpublish, suspension clearing, and future Task 12 hold writers must lock
   * that page row first, before their own subordinate rows/fences.
   */
  resolveVisibleReportTarget(
    db: PawketDatabase | PawketTransaction,
    target: ReportTarget,
  ): Promise<ModerationTargetSnapshot | null>;
  readRevisionTarget(
    db: PawketDatabase | PawketTransaction,
    target: ReportTarget,
  ): Promise<ModerationTargetSnapshot | null>;
}>;
