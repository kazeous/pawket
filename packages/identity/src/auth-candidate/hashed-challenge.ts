import { createHash, randomBytes, randomUUID } from "node:crypto";

export type AuthChallengePurpose = "email_verification" | "password_reset";

export type AuthChallengeRecord = {
  id: string;
  userId: string;
  purpose: AuthChallengePurpose;
  tokenHash: string;
  expiresAt: Date;
  consumedAt: Date | null;
};

function hashChallengeToken(purpose: AuthChallengePurpose, token: string): string {
  return `sha256:${createHash("sha256")
    .update(`pawket:${purpose}\0${token}`, "utf8")
    .digest("base64url")}`;
}

export class InMemoryAuthChallengeStore {
  readonly #records = new Map<string, AuthChallengeRecord>();

  insert(record: AuthChallengeRecord): void {
    this.#records.set(record.id, record);
  }

  async consume(input: {
    purpose: AuthChallengePurpose;
    token: string;
    now: Date;
  }): Promise<AuthChallengeRecord | null> {
    const expectedHash = hashChallengeToken(input.purpose, input.token);
    const record = [...this.#records.values()].find(
      (candidate) =>
        candidate.purpose === input.purpose &&
        candidate.tokenHash === expectedHash &&
        candidate.consumedAt === null &&
        candidate.expiresAt > input.now,
    );
    if (!record) return null;
    record.consumedAt = input.now;
    return structuredClone(record);
  }

  snapshot(): AuthChallengeRecord[] {
    return structuredClone([...this.#records.values()]);
  }
}

export function issueAuthChallenge(input: {
  userId: string;
  purpose: AuthChallengePurpose;
  expiresAt: Date;
  store: InMemoryAuthChallengeStore;
}): { id: string; token: string } {
  const id = randomUUID();
  const token = randomBytes(32).toString("base64url");
  input.store.insert({
    id,
    userId: input.userId,
    purpose: input.purpose,
    tokenHash: hashChallengeToken(input.purpose, token),
    expiresAt: input.expiresAt,
    consumedAt: null,
  });
  return { id, token };
}
