import { timingSafeEqual } from "node:crypto";

import { createOTP } from "@better-auth/utils/otp";

export interface TotpStepStore {
  consumeIfNewer(userId: string, step: number): Promise<boolean>;
}

export class InMemoryTotpStepStore implements TotpStepStore {
  readonly #lastSteps = new Map<string, number>();

  async consumeIfNewer(userId: string, step: number): Promise<boolean> {
    const previous = this.#lastSteps.get(userId);
    if (previous !== undefined && step <= previous) return false;
    this.#lastSteps.set(userId, step);
    return true;
  }
}

function equalCode(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export class TotpReplayGuard {
  constructor(private readonly store: TotpStepStore) {}

  async verifyAndConsume(input: {
    userId: string;
    secret: string;
    code: string;
    now: Date;
  }): Promise<boolean> {
    const period = 30;
    const currentStep = Math.floor(input.now.getTime() / (period * 1_000));
    const otp = createOTP(input.secret, { digits: 6, period });

    for (let offset = -1; offset <= 1; offset += 1) {
      const step = currentStep + offset;
      if (equalCode(input.code, await otp.hotp(step))) {
        return this.store.consumeIfNewer(input.userId, step);
      }
    }
    return false;
  }
}
