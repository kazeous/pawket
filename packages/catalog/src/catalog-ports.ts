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
