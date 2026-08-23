import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

export type RecoveryCodeRecord = {
  userId: string;
  batchId: string;
  codeHash: string;
  consumedAt: Date | null;
};

function generateRecoveryCode(): string {
  const value = randomBytes(16).toString("base64url").toUpperCase();
  return `${value.slice(0, 11)}-${value.slice(11, 22)}`;
}

function hashRecoveryCode(code: string): string {
  return `sha256:${createHash("sha256").update(code, "utf8").digest("base64url")}`;
}

function equalHash(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export class InMemoryRecoveryCodeStore {
  readonly #records = new Map<string, RecoveryCodeRecord[]>();

  replace(userId: string, records: RecoveryCodeRecord[]): void {
    this.#records.set(userId, records);
  }

  async consume(userId: string, code: string): Promise<boolean> {
    const expectedHash = hashRecoveryCode(code);
    const record = this.#records
      .get(userId)
      ?.find((candidate) => candidate.consumedAt === null && equalHash(candidate.codeHash, expectedHash));
    if (!record) return false;
    record.consumedAt = new Date();
    return true;
  }

  snapshot(): RecoveryCodeRecord[] {
    return structuredClone([...this.#records.values()].flat());
  }
}

export async function createRecoveryCodeBatch(
  userId: string,
  store: InMemoryRecoveryCodeStore,
): Promise<{ batchId: string; codes: string[] }> {
  const batchId = randomUUID();
  const codes = Array.from({ length: 10 }, generateRecoveryCode);
  store.replace(
    userId,
    codes.map((code) => ({
      userId,
      batchId,
      codeHash: hashRecoveryCode(code),
      consumedAt: null,
    })),
  );
  return { batchId, codes };
}
