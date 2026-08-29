import { and, eq, isNotNull } from "drizzle-orm";

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
} {
  return {
    async getCreatorSeed(db, userId) {
      const [seed] = await db
        .select({
          userId: identityCreatorCapabilities.userId,
          capabilityState: identityCreatorCapabilities.state,
          capabilityVersion: identityCreatorCapabilities.version,
          approvedRevisionId: identityCreatorCapabilities.approvedRevisionId,
          displayName: creatorApplicationRevisions.artistDisplayName,
          introduction: creatorApplicationRevisions.shortIntroduction,
        })
        .from(identityCreatorCapabilities)
        .innerJoin(
          creatorApplicationRevisions,
          and(
            eq(creatorApplicationRevisions.id, identityCreatorCapabilities.approvedRevisionId),
            eq(creatorApplicationRevisions.applicationId, identityCreatorCapabilities.approvedApplicationId),
          ),
        )
        .where(
          and(
            eq(identityCreatorCapabilities.userId, userId),
            isNotNull(creatorApplicationRevisions.artistDisplayName),
            isNotNull(creatorApplicationRevisions.shortIntroduction),
          ),
        )
        .limit(1);
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
  };
}
