import type { PawketDatabase, PawketTransaction } from "@pawket/database";

export type CreatorReceivingAccountReferencePort = {
  isValidForApplicant(input: {
    applicantUserId: string;
    reference: string;
  }, database?: PawketDatabase | PawketTransaction): Promise<boolean>;
};

const canonicalUuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export function createCanonicalCreatorReceivingAccountReferenceValidator(): CreatorReceivingAccountReferencePort {
  return {
    async isValidForApplicant({ applicantUserId, reference }) {
      void applicantUserId;
      return canonicalUuid.test(reference);
    },
  };
}
