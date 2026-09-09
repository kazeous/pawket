import Link from "next/link";

type Item = Readonly<{ pageId: string; canonicalHandle: string; displayName: string; introduction: string; disciplines: readonly string[]; avatarThumbDerivativeId: string | null }>;

export function CreatorDirectory({ items, nextCursor, query }: Readonly<{ items: readonly Item[]; nextCursor: string | null; query: Readonly<{ discipline: string; handle: string }> }>) {
  const next = new URLSearchParams();
  if (query.discipline) next.set("discipline", query.discipline);
  if (query.handle) next.set("handle", query.handle);
  if (nextCursor) next.set("cursor", nextCursor);
  return <div className="stack">
    {items.length === 0 ? <section className="work-surface"><h2>Chưa có kết quả phù hợp</h2><p>Thử một chuyên ngành hoặc tiền tố handle khác.</p></section> : <ul className="creator-directory">{items.map((item) => <li key={item.pageId}><article className="creator-directory__card stack"><div><p className="eyebrow">@{item.canonicalHandle}</p><h2><Link href={`/creators/${item.canonicalHandle}`}>{item.displayName}</Link></h2></div><p>{item.introduction}</p><ul className="tag-list" aria-label="Chuyên ngành">{item.disciplines.map((discipline) => <li key={discipline}>{discipline}</li>)}</ul></article></li>)}</ul>}
    {nextCursor ? <Link className="button-link secondary" href={`/creators?${next.toString()}`}>Xem thêm nhà sáng tạo</Link> : null}
  </div>;
}
