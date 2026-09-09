import { and, eq, inArray, isNotNull } from "drizzle-orm";

import {
  creatorApplicationRevisions,
  identityCreatorCapabilities,
  type PawketDatabase,
  type PawketTransaction,
} from "@pawket/database";

type CreatorSeed = Readonly<{
  userId: string;
  capabilityState: "active" | "suspended";
  capabilityVersion: number;
  approvedRevisionId: string;
  displayName: string;
  introduction: string;
}>;

export function createIdentityCreatorSeedPort(): {
  getCreatorSeed(
    db: PawketDatabase | PawketTransaction,
    userId: string,
  ): Promise<CreatorSeed | null>;
  getCreatorSeeds(
    db: PawketDatabase | PawketTransaction,
    userIds: readonly string[],
  ): Promise<ReadonlyMap<string, CreatorSeed | null>>;
} {
  async function seeds(db: PawketDatabase | PawketTransaction, userIds: readonly string[]) {
    if (userIds.length === 0) return [];
    return db
      .select({
        userId: identityCreatorCapabilities.userId,
        capabilityState: identityCreatorCapabilities.state,
        capabilityVersion: identityCreatorCapabilities.version,
        approvedRevisionId: identityCreatorCapabilities.approvedRevisionId,
        displayName: creatorApplicationRevisions.artistDisplayName,
        introduction: creatorApplicationRevisions.shortIntroduction,
      })
      .from(identityCreatorCapabilities)
      .innerJoin(creatorApplicationRevisions, and(eq(creatorApplicationRevisions.id, identityCreatorCapabilities.approvedRevisionId), eq(creatorApplicationRevisions.applicationId, identityCreatorCapabilities.approvedApplicationId)))
      .where(and(inArray(identityCreatorCapabilities.userId, [...new Set(userIds)]), isNotNull(creatorApplicationRevisions.artistDisplayName), isNotNull(creatorApplicationRevisions.shortIntroduction)));
  }
  return {
    async getCreatorSeed(db, userId) {
      const [seed] = await seeds(db, [userId]);
      if (!seed || seed.displayName === null || seed.introduction === null) return null;
      return {
        userId: seed.userId,
        capabilityState: seed.capabilityState as "active" | "suspended",
        capabilityVersion: seed.capabilityVersion,
        approvedRevisionId: seed.approvedRevisionId,
        displayName: seed.displayName,
        introduction: seed.introduction,
      };
    },
    async getCreatorSeeds(db, userIds) {
      const uniqueUserIds = [...new Set(userIds)];
      const rows = await seeds(db, uniqueUserIds);
      const byUser = new Map(rows.map((seed) => [seed.userId, seed] as const));
      return new Map(uniqueUserIds.map((userId) => {
        const seed = byUser.get(userId);
        return [userId, !seed || seed.displayName === null || seed.introduction === null ? null : {
          userId: seed.userId,
          capabilityState: seed.capabilityState as "active" | "suspended",
          capabilityVersion: seed.capabilityVersion,
          approvedRevisionId: seed.approvedRevisionId,
          displayName: seed.displayName,
          introduction: seed.introduction,
        }] as const;
      }));
    },
  };
}
