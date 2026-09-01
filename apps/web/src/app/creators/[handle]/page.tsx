import { loadServerEnv } from "@pawket/config";
import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";

import { getPlatformRuntime } from "../../../platform/runtime";
import { AppShell } from "../../../ui/app-shell";
import { ReportForm } from "./report-form";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: Readonly<{ params: Promise<{ handle: string }> }>): Promise<Metadata> {
  if (loadServerEnv().CREATOR_PUBLISHING_MODE !== "general_audience") return { robots: { index: false, follow: false } };
  const { handle } = await params;
  const result = await getPlatformRuntime().publicCatalog.resolvePublicCreator(handle);
  if (result.kind !== "visible") return { robots: { index: false, follow: false } };
  return { title: `${result.page.displayName} · Pawket`, description: result.page.introduction, alternates: { canonical: `/creators/${result.page.canonicalHandle}` } };
}

export default async function PublicCreatorPage({ params }: Readonly<{ params: Promise<{ handle: string }> }>) {
  if (loadServerEnv().CREATOR_PUBLISHING_MODE !== "general_audience") notFound();
  const { handle } = await params; const result = await getPlatformRuntime().publicCatalog.resolvePublicCreator(handle);
  if (result.kind === "redirect") permanentRedirect(`/creators/${result.canonicalHandle}`);
  if (result.kind !== "visible") notFound();
  const page = result.page;
  return <AppShell context={`@${page.canonicalHandle}`} action={{ href: "/creators", label: "Khám phá" }}><article className="creator-publication stack">
    <header className="creator-publication__header stack"><div><p className="eyebrow">@{page.canonicalHandle}</p><h1>{page.displayName}</h1><p className="lede">{page.introduction}</p><p className="muted">{[page.primaryDiscipline, ...page.secondaryDisciplines].join(" · ")}</p></div><ReportForm label="Báo cáo trang này" target={{ targetType: "page", targetId: page.pageId, publicationRevisionId: page.revisionId }} /></header>
    {page.showcases.map((showcase) => <section className="creator-showcase stack" key={showcase.sourceShowcaseId}><div><p className="eyebrow">{showcase.discipline}</p><h2>{showcase.title}</h2><p>{showcase.description}</p></div><div className="creator-showcase__media">{showcase.media.map((media) => <img key={media.assetId} src={`/media/${media.assetId}/display`} width={media.dimensions.display.width} height={media.dimensions.display.height} alt={media.alternativeText} />)}</div>{showcase.externalUrl ? <a className="text-link" href={showcase.externalUrl} target="_blank" rel="noopener noreferrer external" referrerPolicy="no-referrer">Mở tác phẩm ngoài Pawket</a> : null}<ReportForm label={`Báo cáo showcase ${showcase.title}`} target={{ targetType: "showcase", targetId: showcase.sourceShowcaseId, publicationRevisionId: page.revisionId }} /></section>)}
  </article></AppShell>;
}
