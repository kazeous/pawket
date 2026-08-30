import { types as nodeTypes } from "node:util";

import { sql } from "drizzle-orm";

import type { PawketTransaction } from "./client.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/**
 * Shared transaction fence for destructive public-media retention and every
 * writer that can create an asset reference or retention hold.
 *
 * Callers that also serialize an asset or creator page must acquire those row
 * locks first, in stable ID order, and acquire these fences last. A hold-only
 * writer acquires this fence before publishing the hold and revalidates the
 * asset after acquiring it.
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
