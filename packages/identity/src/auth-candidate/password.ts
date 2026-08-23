import { Algorithm, hash, verify, type Options } from "@node-rs/argon2";

export const passwordHashOptions = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 65_536,
  timeCost: 3,
  parallelism: 1,
  outputLen: 32,
} satisfies Options;

export function validatePasswordLength(password: string): boolean {
  const length = Array.from(password).length;
  return length >= 15 && length <= 128;
}

export function hashPassword(password: string): Promise<string> {
  return hash(password, passwordHashOptions);
}

export function verifyPassword(data: { hash: string; password: string }): Promise<boolean> {
  return verify(data.hash, data.password, passwordHashOptions);
}

export function passwordHashNeedsUpgrade(passwordHash: string): boolean {
  const match = passwordHash.match(/^\$argon2id\$v=(\d+)\$m=(\d+),t=(\d+),p=(\d+)\$/);
  if (!match) return true;

  const [, version, memoryCost, timeCost, parallelism] = match;
  return (
    Number(version) !== 19 ||
    Number(memoryCost) < passwordHashOptions.memoryCost! ||
    Number(timeCost) < passwordHashOptions.timeCost! ||
    Number(parallelism) < passwordHashOptions.parallelism!
  );
}
