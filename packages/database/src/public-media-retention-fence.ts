import { types as nodeTypes } from "node:util";

import { sql } from "drizzle-orm";

import type { PawketTransaction } from "./client.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/**
 * Shared transaction fence for destructive public-media retention and every
 * writer that can create an asset reference or retention hold.
 *
 * Cleanup owns the destructive order: stable asset rows, stable creator-page
 * rows, then sorted fences. Existing Catalog mutations remain page-first:
 * after locking their owned page they acquire sorted fences, never lock asset
 * rows, and revalidate ready ownership/purpose through Catalog's consumer-owned
 * media port before writing a new reference. Thus writer-first makes cleanup's
 * final revalidation observe the reference; cleanup-first makes the waking
 * writer observe the deleted/non-ready asset and roll back.
 *
 * Task 11/12 hold writers that do not need a creator-page row acquire sorted
 * fences, revalidate the asset after acquiring them, then publish the hold.
 * Task 13 cross-domain transitions must preserve whichever domain row order
 * they already own and acquire this fence only after those rows; they must not
 * add page-to-asset row locking. Every participant holds its fence to commit.
 */
export async function acquirePublicMediaRetentionFences(
  tx: PawketTransaction,
  assetIds: readonly string[],
): Promise<void> {
  if (!Array.isArray(assetIds) || nodeTypes.isProxy(assetIds)) throw new TypeError("PUBLIC_MEDIA_RETENTION_FENCE_INVALID");
  let values: unknown[];
  try { values = Array.prototype.slice.call(assetIds) as unknown[]; }
  catch { throw new TypeError("PUBLIC_MEDIA_RETENTION_FENCE_INVALID"); }
  if (values.length < 1 || values.length > 500) throw new TypeError("PUBLIC_MEDIA_RETENTION_FENCE_INVALID");
  const unique = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string" || !UUID.test(value)) throw new TypeError("PUBLIC_MEDIA_RETENTION_FENCE_INVALID");
    unique.add(value.toLowerCase());
  }
  for (const assetId of [...unique].sort()) {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`public-media-retention:${assetId}`}, 0))`);
  }
}
