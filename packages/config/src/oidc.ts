import { z } from "zod";

const endpoint = z.string().min(1).max(2048).url();
const schema = z.object({
  OIDC_ISSUER: endpoint,
  OIDC_CLIENT_ID: z.string().min(1).max(255).regex(/^[A-Za-z0-9._-]+$/u),
  OIDC_CLIENT_SECRET: z.string().min(32).max(2048).regex(/^[^\s\p{Cc}]+$/u),
  OIDC_PROVIDER_REVISION: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u),
  OIDC_ACCOUNT_PORTAL_URL: endpoint,
});

/** Workers need the public trust boundary, never the confidential client secret. */
export function parseOidcSessionEnv(input: NodeJS.ProcessEnv | Record<string, string | undefined>) {
  const parsed = schema.pick({ OIDC_ISSUER: true, OIDC_CLIENT_ID: true, OIDC_PROVIDER_REVISION: true }).safeParse(input);
  if (!parsed.success) throw new Error(`Invalid OIDC configuration: ${[...new Set(parsed.error.issues.map((issue) => issue.path[0]))].join(", ")}`);
  const issuer = new URL(parsed.data.OIDC_ISSUER);
  if (issuer.protocol !== "https:" || issuer.username || issuer.password || issuer.search || issuer.hash) throw new Error("Invalid OIDC issuer configuration");
  return Object.freeze({ issuer: parsed.data.OIDC_ISSUER, clientId: parsed.data.OIDC_CLIENT_ID, providerRevision: parsed.data.OIDC_PROVIDER_REVISION });
}

/** No legacy fallback or test bypass: a runtime must have a complete provider. */
export function parseOidcEnv(input: NodeJS.ProcessEnv | Record<string, string | undefined>, appBaseUrl: string) {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path[0]))].join(", ");
    throw new Error(`Invalid OIDC configuration: ${fields}`);
  }
  const env = parsed.data;
  const issuer = new URL(env.OIDC_ISSUER); const portal = new URL(env.OIDC_ACCOUNT_PORTAL_URL);
  const base = new URL(appBaseUrl);
  const plain = (url: URL) => !url.username && !url.password && !url.search && !url.hash;
  if (!plain(issuer) || !plain(portal) || issuer.protocol !== "https:" || portal.origin !== issuer.origin ||
    !plain(base) || base.pathname !== "/" || (base.protocol !== "https:" &&
      !(base.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)))) {
    throw new Error("Invalid OIDC endpoint configuration");
  }
  return Object.freeze({ issuer: env.OIDC_ISSUER, clientId: env.OIDC_CLIENT_ID, clientSecret: env.OIDC_CLIENT_SECRET,
    providerRevision: env.OIDC_PROVIDER_REVISION, accountPortalUrl: env.OIDC_ACCOUNT_PORTAL_URL,
    redirectUri: new URL("/api/v1/auth/oidc/callback", base).href });
}
