import type { BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { generateCodeChallenge, validateAuthorizationCode } from "better-auth/oauth2";

type AuthContext = Parameters<NonNullable<BetterAuthPlugin["init"]>>[0];
const nonceBoundProviders = new WeakSet<object>();
const pkceBoundProviders = new WeakSet<object>();

function bindGoogleNonce(context: AuthContext): "missing" | "already" | "wrapped" {
  const provider = context.socialProviders.find((candidate) => candidate.id === "google");
  if (!provider) return "missing";
  if (nonceBoundProviders.has(provider)) return "already";
  const createAuthorizationURL = provider.createAuthorizationURL.bind(provider);
  Object.assign(provider, {
    requiresIdTokenNonce: true,
    issuer: "https://accounts.google.com",
    createAuthorizationURL: async (
      input: Parameters<typeof createAuthorizationURL>[0],
    ) => {
      if (!input.idTokenNonce) {
        throw new Error("Google OIDC nonce binding is unavailable");
      }
      const url = await createAuthorizationURL(input);
      url.searchParams.set("nonce", input.idTokenNonce);
      return url;
    },
  });
  nonceBoundProviders.add(provider);
  return "wrapped";
}

function bindDiscordPkce(context: AuthContext): void {
  const provider = context.socialProviders.find((candidate) => candidate.id === "discord");
  if (!provider || pkceBoundProviders.has(provider)) return;
  const createAuthorizationURL = provider.createAuthorizationURL.bind(provider);
  Object.assign(provider, {
    accountIssuer: "https://discord.com",
    createAuthorizationURL: async (
      input: Parameters<typeof createAuthorizationURL>[0],
    ) => {
      if (!input.codeVerifier) throw new Error("Discord PKCE binding is unavailable");
      const url = await createAuthorizationURL(input);
      url.searchParams.set("code_challenge_method", "S256");
      url.searchParams.set("code_challenge", await generateCodeChallenge(input.codeVerifier));
      return url;
    },
    validateAuthorizationCode: async (
      input: Parameters<typeof provider.validateAuthorizationCode>[0],
    ) => {
      if (!input.codeVerifier) throw new Error("Discord PKCE verifier is unavailable");
      return validateAuthorizationCode({
        code: input.code,
        codeVerifier: input.codeVerifier,
        redirectURI: input.redirectURI,
        options: provider.options ?? {},
        tokenEndpoint: "https://discord.com/api/oauth2/token",
      });
    },
  });
  pkceBoundProviders.add(provider);
}

export function googleOidcNoncePlugin(): BetterAuthPlugin {
  return {
    id: "pawket-google-oidc-nonce",
    init(context) {
      bindGoogleNonce(context);
      bindDiscordPkce(context);
    },
    hooks: {
      before: [
        {
          matcher(context) {
            return (
              context.path === "/sign-in/social" ||
              context.path === "/link-social" ||
              context.path === "/callback/google"
            );
          },
          handler: createAuthMiddleware(async (context) => {
            bindGoogleNonce(context.context as AuthContext);
            bindDiscordPkce(context.context as AuthContext);
          }),
        },
      ],
    },
  };
}
