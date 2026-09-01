import { randomUUID } from "node:crypto";

import { loadServerEnv } from "@pawket/config";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";

import { getPlatformRuntime } from "../../../platform/runtime";
import { AppShell } from "../../../ui/app-shell";

export const dynamic = "force-dynamic";

export default async function CreatorPreviewPage() {
  const requestHeaders = await headers();
  const platform = getPlatformRuntime();
  const session = await platform.authenticate(requestHeaders);
  if (!session) redirect("/sign-in");
  if (await platform.authorizeCreator(requestHeaders) !== "authorized" || loadServerEnv().CREATOR_PUBLISHING_MODE !== "general_audience") notFound();
  const workspace = await platform.catalog.initialize({ userId: session.userId, requestId: requestHeaders.get("x-request-id") ?? randomUUID() });

  return <AppShell context="Bản xem trước" action={{ href: "/creator", label: "Quay lại chỉnh sửa" }}>
    <article className="creator-publication publication-preview stack">
      <header className="creator-publication__header"><p className="eyebrow">Bản nháp riêng tư</p><h1>{workspace.draft.displayName}</h1><p className="lede">{workspace.draft.introduction}</p><p className="muted">Chỉ tài khoản creator sở hữu trang này có thể xem dữ liệu và media nháp.</p></header>
      {workspace.showcases.map((showcase) => <section className="creator-showcase stack" key={showcase.id}><div><p className="eyebrow">{showcase.discipline}</p><h2>{showcase.title}</h2><p>{showcase.description}</p></div><div className="creator-showcase__media">{showcase.media.map((media) => <img key={media.assetId} src={`/media/${media.assetId}/display?preview=1`} width={800} height={600} alt={media.alternativeText} />)}</div>{showcase.externalUrl ? <a className="text-link" href={showcase.externalUrl} target="_blank" rel="noopener noreferrer external" referrerPolicy="no-referrer">Mở tác phẩm ngoài Pawket</a> : null}</section>)}
    </article>
  </AppShell>;
}
