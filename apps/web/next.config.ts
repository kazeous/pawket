import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const configDirectory = path.dirname(fileURLToPath(import.meta.url));
const securityHeaders = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Cross-Origin-Opener-Policy": "same-origin",
  "X-Frame-Options": "DENY",
};

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: path.join(configDirectory, "../.."),
  serverExternalPackages: ["@aws-sdk/client-s3", "@aws-sdk/s3-request-presigner", "@node-rs/argon2"],
  webpack(config) {
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      ".js": [".ts", ".tsx", ".js"],
      ".mjs": [".mts", ".mjs"],
      ".cjs": [".cts", ".cjs"],
    };
    return config;
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: Object.entries(securityHeaders).map(([key, value]) => ({ key, value })),
      },
      ...["/", "/register", "/verify-email/:path*", "/sign-in/:path*", "/forgot-password", "/reset-password", "/settings/:path*", "/creator/:path*", "/admin/:path*"].map((source) => ({
        source,
        headers: [
          { key: "Cache-Control", value: "private, no-store, max-age=0" },
          { key: "Referrer-Policy", value: "no-referrer" },
        ],
      })),
    ];
  },
};

export default nextConfig;
