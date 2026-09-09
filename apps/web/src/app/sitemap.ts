import { loadServerEnv } from "@pawket/config";
import type { MetadataRoute } from "next";

import { getPlatformRuntime } from "../platform/runtime";

export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const env = loadServerEnv();
  if (env.CREATOR_PUBLISHING_MODE !== "general_audience") return [];
  const creators = await getPlatformRuntime().publicCatalog.listSitemapCreators();
  return creators.map(({ canonicalHandle, publishedAt }) => ({ url: new URL(`/creators/${canonicalHandle}`, env.APP_BASE_URL).toString(), lastModified: publishedAt, changeFrequency: "weekly" as const }));
}
